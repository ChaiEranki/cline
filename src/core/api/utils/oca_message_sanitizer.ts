import {
	ClineAssistantRedactedThinkingBlock,
	ClineAssistantThinkingBlock,
	ClineAssistantToolUseBlock,
	ClineContent,
	ClineStorageMessage,
	ClineTextContentBlock,
	ClineUserToolResultContentBlock,
} from "@/shared/messages/content"

export type OcaTargetApi = "chat" | "responses" | "messages"

interface SanitizeState {
	toolUseIdToCallId: Map<string, string>
	autoIdCounter: number
}

/**
 * Returns a sanitized copy of the stored conversation that is safe to forward to the
 * requested API. Switching a conversation between OpenAI Chat Completions, OpenAI
 * Responses, and Anthropic Messages surfaces subtle incompatibilities:
 *
 * - Chat Completions rejects tool calls whose IDs exceed 40 characters or whose
 *   tool_result blocks reference unknown IDs.
 * - Responses requires every reasoning block to reference the surrounding
 *   function_call via a call_id. Historical thinking blocks coming from other
 *   providers frequently omit this metadata.
 * - Messages (Anthropic) does not understand Cline-specific fields like call_id,
 *   causing validation errors unless they are stripped.
 *
 * This helper performs a light, non-destructive sanitization tailored to each API
 * while preserving as much conversational context as possible.
 */
export function sanitizeOcaMessagesForApi(
	messages: ClineStorageMessage[],
	target: OcaTargetApi,
): ClineStorageMessage[] {
	const state: SanitizeState = {
		toolUseIdToCallId: new Map<string, string>(),
		autoIdCounter: 0,
	}

	return messages.map((message) => sanitizeMessage(clone(message), target, state))
}

function sanitizeMessage(
	message: ClineStorageMessage,
	target: OcaTargetApi,
	state: SanitizeState,
): ClineStorageMessage {
	if (typeof message.content === "string") {
		return message
	}

	const sanitizedContent: ClineContent[] = []

	for (const rawBlock of message.content) {
		const block = clone(rawBlock)

		if (isAssistantToolUseBlock(block)) {
			const id = ensureToolUseId(block, state)
			const callId = ensureToolUseCallId(block, id, state, target)
			sanitizeToolInput(block)
			state.toolUseIdToCallId.set(id, callId)
			sanitizedContent.push(block)
			continue
		}

		if (isToolResultBlock(block)) {
			const toolUseId = ensureToolResultToolUseId(block, state)
			ensureToolResultCallId(block, toolUseId, state, target)
			sanitizedContent.push(block)
			continue
		}

		if (isThinkingBlock(block) || isRedactedThinkingBlock(block)) {
			if (target === "messages") {
				// Anthropic drops thinking blocks lacking signatures which can result in an empty
				// assistant turn (and the UI getting stuck in a loading state). Convert those
				// blocks into plain text so the turn still has visible content.
				const hasSignature = "signature" in block && Boolean((block as any).signature)
				if (!hasSignature) {
					const fallbackText = extractThinkingText(block)
					if (fallbackText) {
						sanitizedContent.push({
							type: "text",
							text: fallbackText,
						} satisfies ClineTextContentBlock)
					}
					continue
				}
			}

			if (target === "responses" && !block.call_id) {
				const fallbackText = extractThinkingText(block)
				if (fallbackText) {
					sanitizedContent.push({
						type: "text",
						text: fallbackText,
					} satisfies ClineTextContentBlock)
				}
				continue
			}

			if (target === "chat" && block.call_id) {
				// Chat Completions does not accept call_id on thinking blocks – remove it so
				// downstream conversion does not expose unsupported fields.
				delete block.call_id
			}

			sanitizedContent.push(block)
			continue
		}

		sanitizedContent.push(block)
	}

	return {
		...message,
		content: sanitizedContent,
	}
}

function ensureToolUseId(block: ClineAssistantToolUseBlock, state: SanitizeState): string {
	if (block.id && typeof block.id === "string") {
		return block.id
	}

	const generatedId = `oca_tool_${state.autoIdCounter++}`
	block.id = generatedId
	return generatedId
}

function ensureToolUseCallId(
	block: ClineAssistantToolUseBlock,
	id: string,
	state: SanitizeState,
	target: OcaTargetApi,
): string {
	const rawCallId = block.call_id && typeof block.call_id === "string" ? block.call_id : id
	const callId = target === "chat" ? normalizeChatToolCallId(rawCallId) : rawCallId
	block.call_id = callId
	return callId
}

function sanitizeToolInput(block: ClineAssistantToolUseBlock) {
	if (block.input === undefined || block.input === null) {
		block.input = {}
		return
	}

	if (typeof block.input === "string") {
		try {
			block.input = JSON.parse(block.input)
		} catch {
			block.input = {}
		}
	}
}

function ensureToolResultToolUseId(
	block: ClineUserToolResultContentBlock,
	state: SanitizeState,
): string {
	if (block.tool_use_id) {
		return block.tool_use_id
	}

	const inferredToolId = [...state.toolUseIdToCallId.keys()].at(-1)
	const generatedToolId = inferredToolId ?? `oca_tool_${state.autoIdCounter++}`
	block.tool_use_id = generatedToolId
	return generatedToolId
}

function ensureToolResultCallId(
	block: ClineUserToolResultContentBlock,
	toolUseId: string,
	state: SanitizeState,
	target: OcaTargetApi,
) {
	const rawCallId =
		block.call_id && typeof block.call_id === "string"
			? block.call_id
			: state.toolUseIdToCallId.get(toolUseId) ?? toolUseId

	block.call_id = target === "chat" ? normalizeChatToolCallId(rawCallId) : rawCallId
}

function extractThinkingText(
	block: ClineAssistantThinkingBlock | ClineAssistantRedactedThinkingBlock,
): string | undefined {
	if (isThinkingBlock(block)) {
		return block.thinking?.trim() ? block.thinking : undefined
	}

	if (isRedactedThinkingBlock(block)) {
		return block.data ? "[Redacted thinking block]" : undefined
	}

	return undefined
}

function normalizeChatToolCallId(original: string): string {
	const maxLength = 40
	if (original.length <= maxLength) {
		return original
	}
	return `call_${original.slice(original.length - (maxLength - 5))}`
}

function isAssistantToolUseBlock(block: ClineContent): block is ClineAssistantToolUseBlock {
	return block.type === "tool_use"
}

function isToolResultBlock(block: ClineContent): block is ClineUserToolResultContentBlock {
	return block.type === "tool_result"
}

function isThinkingBlock(block: ClineContent): block is ClineAssistantThinkingBlock {
	return block.type === "thinking"
}

function isRedactedThinkingBlock(block: ClineContent): block is ClineAssistantRedactedThinkingBlock {
	return block.type === "redacted_thinking"
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}