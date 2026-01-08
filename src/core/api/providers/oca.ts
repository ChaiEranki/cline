import { liteLlmDefaultModelId, liteLlmModelInfoSaneDefaults, ModelInfo } from "@shared/api"
import OpenAI, { APIError, OpenAIError } from "openai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { OcaAuthService } from "@/services/auth/oca/OcaAuthService"
import {
	DEFAULT_EXTERNAL_OCA_BASE_URL,
	DEFAULT_INTERNAL_OCA_BASE_URL,
	OCI_HEADER_OPC_REQUEST_ID,
} from "@/services/auth/oca/utils/constants"
import { createOcaHeaders } from "@/services/auth/oca/utils/utils"
import { Logger } from "@/services/logging/Logger"
import { OcaModelInfo } from "@/shared/api"
import { ClineStorageMessage } from "@/shared/messages/content"
import { fetch } from "@/shared/net"
import { type CommonApiHandlerOptions } from ".."
import { withRetry } from "../retry"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { ApiStream } from "../transform/stream"
import { getOpenAIToolParams, ToolCallProcessor } from "../transform/tool-call-processor"
import { OpenAiNativeHandler } from "./openai-native"

export interface OcaHandlerOptions extends CommonApiHandlerOptions {
	ocaBaseUrl?: string
	ocaModelId?: string
	ocaModelInfo?: OcaModelInfo
	ocaReasoningEffort?: string
	thinkingBudgetTokens?: number
	ocaUsePromptCache?: boolean
	taskId?: string
	ocaMode?: string // "internal" or "external"
}

export class OcaHandler extends OpenAiNativeHandler {
	protected ocaOptions: OcaHandlerOptions

	constructor(ocaOptions: OcaHandlerOptions) {
		super({})
		this.ocaOptions = ocaOptions
	}

	protected initializeClient(ocaOptions: OcaHandlerOptions) {
		return new (class OCIOpenAI extends OpenAI {
			protected override async prepareOptions(opts: any): Promise<void> {
				const token = await OcaAuthService.getInstance().getAuthToken()
				if (!token) {
					throw new OpenAIError("Unable to handle auth, Oracle Code Assist (OCA) access token is not available")
				}
				opts.headers ??= {}
				// OCA Headers
				const ociHeaders = await createOcaHeaders(token, ocaOptions.taskId!)
				opts.headers = { ...opts.headers, ...ociHeaders }
				Logger.log(`Making request with customer opc-request-id: ${opts.headers?.["opc-request-id"]}`)
				return super.prepareOptions(opts)
			}

			protected override makeStatusError(
				status: number | undefined,
				error: Object | undefined,
				message: string | undefined,
				headers: any | undefined,
			): APIError {
				interface OciError {
					code?: string
					message?: string
				}
				let ociErrorMessage = message
				if (typeof error === "object" && error !== null) {
					try {
						ociErrorMessage = JSON.stringify(error)
						const ociErr = error as OciError
						if (ociErr.code !== undefined && ociErr.message !== undefined) {
							ociErrorMessage = `${ociErr.code}: ${ociErr.message}`
						}
					} catch {}
				}
				const opcRequestId = headers?.[OCI_HEADER_OPC_REQUEST_ID]
				if (opcRequestId) {
					ociErrorMessage += `\n(${OCI_HEADER_OPC_REQUEST_ID}: ${opcRequestId})`
				}
				const statusCode = typeof status === "number" ? status : 500
				return super.makeStatusError(statusCode, error ?? {}, ociErrorMessage, headers)
			}
		})({
			baseURL:
				ocaOptions.ocaBaseUrl ||
				(ocaOptions.ocaMode === "internal" ? DEFAULT_INTERNAL_OCA_BASE_URL : DEFAULT_EXTERNAL_OCA_BASE_URL),
			apiKey: "noop",
			fetch, // Use configured fetch with proxy support
		})
	}

	override ensureClient(): OpenAI {
		if (!this.client) {
			if (!this.ocaOptions.ocaModelId) {
				throw new Error("Oracle Code Assist (OCA) model is not selected")
			}
			try {
				this.client = this.initializeClient(this.ocaOptions)
			} catch (error) {
				throw new Error(`Error creating Oracle Code Assist (OCA) client: ${error.message}`)
			}
		}
		return this.client
	}

	async getApiCosts(prompt_tokens: number, completion_tokens: number): Promise<number | undefined> {
		// Reference: https://github.com/BerriAI/litellm/blob/122ee634f434014267af104814022af1d9a0882f/litellm/proxy/spend_tracking/spend_management_endpoints.py#L1473
		const client = this.ensureClient()
		const modelId = this.ocaOptions.ocaModelId || liteLlmDefaultModelId
		const token = await OcaAuthService.getInstance().getAuthToken()
		if (!token) {
			throw new OpenAIError("Unable to handle auth, Oracle Code Assist (OCA) access token is not available")
		}
		const ociHeaders = await createOcaHeaders(token, this.ocaOptions.taskId!)
		Logger.log(`Making calculate cost request with customer opc-request-id: ${ociHeaders["opc-request-id"]}`)
		try {
			const response = await fetch(`${client.baseURL}/spend/calculate`, {
				method: "POST",
				headers: ociHeaders,
				body: JSON.stringify({
					completion_response: {
						model: modelId,
						usage: {
							prompt_tokens,
							completion_tokens,
						},
					},
				}),
			})

			if (response.ok) {
				const data: { cost: number } = await response.json()
				return data.cost
			} else {
				console.error("Error calculating spend:", response.statusText)
				return undefined
			}
		} catch (error) {
			console.error("Error calculating spend:", error)
			return undefined
		}
	}

	@withRetry()
	override async *createMessage(systemPrompt: string, messages: ClineStorageMessage[], tools?: OpenAITool[]): ApiStream {
		const model = this.ocaOptions.ocaModelInfo
		if (model?.supportsResponsesApi) {
			const supportsReasoningEffort = model.supportsReasoning
			const selectedReasoningEffort = this.ocaOptions.ocaReasoningEffort
			yield* this.createResponseStream(
				systemPrompt,
				messages,
				tools ?? [],
				false,
				supportsReasoningEffort,
				selectedReasoningEffort,
			)
		} else {
			yield* this.createCompletionStream(systemPrompt, messages, tools)
		}
	}

	protected override async *createCompletionStream(
		systemPrompt: string,
		messages: ClineStorageMessage[],
		tools?: OpenAITool[],
	): ApiStream {
		console.log("Using Chat API")
		const client = this.ensureClient()
		const formattedMessages = convertToOpenAiMessages(messages)
		const systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
			role: "system",
			content: systemPrompt,
		}
		const model = this.getModel()
		const modelId = model.id
		const isOminiModel = modelId.includes("o1-mini") || modelId.includes("o3-mini") || modelId.includes("o4-mini")

		// Configuration for extended thinking
		const budgetTokens = this.ocaOptions.thinkingBudgetTokens || 0
		const reasoningOn = budgetTokens !== 0
		const thinkingConfig = reasoningOn ? { type: "enabled", budget_tokens: budgetTokens } : undefined

		let temperature: number | undefined = this.ocaOptions.ocaModelInfo?.temperature ?? 0
		const maxTokens: number | undefined = this.ocaOptions.ocaModelInfo?.maxTokens

		if (isOminiModel && reasoningOn) {
			temperature = undefined // Thinking mode doesn't support temperature
		}

		// Define cache control object if prompt caching is enabled
		const cacheControl = this.ocaOptions.ocaUsePromptCache ? { cache_control: { type: "ephemeral" } } : undefined

		// Add cache_control to system message if enabled
		const enhancedSystemMessage = {
			...systemMessage,
			...(cacheControl && cacheControl),
		}

		// Find the last two user messages to apply caching
		const userMsgIndices = formattedMessages.reduce((acc, msg, index) => {
			if (msg.role === "user") {
				acc.push(index)
			}
			return acc
		}, [] as number[])
		const lastUserMsgIndex = userMsgIndices[userMsgIndices.length - 1] ?? -1
		const secondLastUserMsgIndex = userMsgIndices[userMsgIndices.length - 2] ?? -1

		// Apply cache_control to the last two user messages if enabled
		const enhancedMessages = formattedMessages.map((message, index) => {
			if ((index === lastUserMsgIndex || index === secondLastUserMsgIndex) && cacheControl) {
				return {
					...message,
					...cacheControl,
				}
			}
			return message
		})

		const toolCallProcessor = new ToolCallProcessor()

		const chatCompletionsParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
			model: modelId || liteLlmDefaultModelId,
			messages: [enhancedSystemMessage, ...enhancedMessages],
			temperature,
			stream: true,
			max_completion_tokens: maxTokens,
			max_tokens: maxTokens,
			stream_options: { include_usage: true },
			...(thinkingConfig && { thinking: thinkingConfig }), // Add thinking configuration when applicable
			...(this.ocaOptions.taskId && {
				litellm_session_id: `cline-${this.ocaOptions.taskId}`,
				...getOpenAIToolParams(tools),
			}), // Add session ID for LiteLLM tracking
		}

		if (this.ocaOptions.ocaModelInfo?.supportsReasoningEffort) {
			chatCompletionsParams["reasoning_effort"] = this.ocaOptions.ocaReasoningEffort || ("medium" as any)
		}

		const stream = await client.chat.completions.create(chatCompletionsParams)

		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta

			// Handle normal text content
			if (delta?.content) {
				yield {
					type: "text",
					text: delta.content,
				}
			}

			// Handle reasoning events (thinking)
			// Thinking is not in the standard types but may be in the response
			interface ThinkingDelta {
				thinking?: string
			}

			if ((delta as ThinkingDelta)?.thinking) {
				yield {
					type: "reasoning",
					reasoning: (delta as ThinkingDelta).thinking || "",
				}
			}

			if (delta?.tool_calls) {
				yield* toolCallProcessor.processToolCallDeltas(delta.tool_calls)
			}

			// Handle token usage information
			if (chunk.usage) {
				// Extract cache-related information if available
				// Need to use type assertion since these properties are not in the standard OpenAI types
				const usage = chunk.usage as {
					prompt_tokens: number
					completion_tokens: number
					cache_creation_input_tokens?: number
					prompt_cache_miss_tokens?: number
					cache_read_input_tokens?: number
					prompt_cache_hit_tokens?: number
				}

				const cacheWriteTokens = usage.cache_creation_input_tokens || usage.prompt_cache_miss_tokens || 0
				const cacheReadTokens = usage.cache_read_input_tokens || usage.prompt_cache_hit_tokens || 0

				const totalCost = await this.calculateCost(
					model.info,
					chunk.usage.prompt_tokens,
					chunk.usage.completion_tokens,
					cacheWriteTokens,
					cacheReadTokens,
				)

				yield {
					type: "usage",
					inputTokens: usage.prompt_tokens || 0,
					outputTokens: usage.completion_tokens || 0,
					cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
					cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
					totalCost,
				}
			}
		}
	}

	override getModel() {
		return {
			id: this.ocaOptions.ocaModelId || liteLlmDefaultModelId,
			info: this.ocaOptions.ocaModelInfo || liteLlmModelInfoSaneDefaults,
		}
	}

	override async calculateCost(
		modelInfo: ModelInfo,
		inputTokens: number,
		outputTokens: number,
		cacheWriteTokens: number,
		cacheReadTokens: number,
	): Promise<number> {
		const inputCost = (await this.getApiCosts(1e6, 0)) || 0
		const outputCost = (await this.getApiCosts(0, 1e6)) || 0
		const totalCost = (inputCost * inputTokens) / 1e6 + (outputCost * outputTokens) / 1e6
		return totalCost
	}
}
