import type { ApiConfiguration } from "@shared/api"
import { VectorStoreInfo } from "@shared/proto/index.cline"
import { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { normalizeApiConfiguration } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

export interface OcaVectorPickerProps {
	apiConfiguration: ApiConfiguration | undefined
	currentMode: Mode
	ocaKbs: Record<string, VectorStoreInfo>
	onRefresh: () => void | Promise<void>
	loading?: boolean
	lastRefreshedAt?: number | null
}

const OcaVectorPicker: React.FC<OcaVectorPickerProps> = ({
	apiConfiguration,
	currentMode,
	ocaKbs,
	onRefresh,
	loading,
	lastRefreshedAt,
}: OcaVectorPickerProps) => {
	const { handleModeFieldChange } = useApiConfigurationHandlers()

	const handleKbChange = async (kbs: string[]) => {
		await handleModeFieldChange({ plan: "planModeOcaVectorIds", act: "actModeOcaVectorIds" }, kbs, currentMode)
	}

	const handleRefreshToken = async () => {
		await onRefresh?.()
	}

	const { selectedVectorIds } = useMemo(() => {
		return normalizeApiConfiguration(apiConfiguration, currentMode)
	}, [apiConfiguration, currentMode])

	const kbIds = useMemo(() => {
		return Object.keys(ocaKbs || []).sort((a, b) => ocaKbs[a].name.localeCompare(ocaKbs[b].name))
	}, [ocaKbs])

	const lastRefreshedText = useMemo(() => {
		return typeof lastRefreshedAt === "number" ? new Date(lastRefreshedAt).toLocaleTimeString() : null
	}, [lastRefreshedAt])

	const toggleOption = async (option: { id: string; name: string }) => {
		const prevVectorIds = selectedVectorIds || []
		const newVectorIds = prevVectorIds.includes(option.id)
			? prevVectorIds.filter((o) => o !== option.id)
			: [...prevVectorIds, option.id]
		await handleKbChange(newVectorIds)
	}

	return (
		<div className="w-full" style={{ height: "100%" }}>
			<style>{`
				#knowledge-base-id::part(listbox){
					max-height: 100px;
					overflow: auto;
				}
			`}</style>
			<label className="font-medium text-[12px] mt-[10px] mb-[2px]">Knowledge Base</label>
			<div
				className="relative z-[100] flex items-center gap-2 mb-1"
				style={{
					height: "100%",
				}}>
				<MultiSelectDropdown
					className="flex-1 text-[12px] min-h-[24px]"
					id="knowledge-base-id"
					options={kbIds.map((kbId) => {
						return {
							id: kbId,
							name: ocaKbs[kbId].name,
						}
					})}
					selectedIds={selectedVectorIds || []}
					toggleOption={toggleOption}
				/>
				<VSCodeButton
					disabled={!!loading}
					onClick={handleRefreshToken}
					style={{
						fontSize: 14,
						fontWeight: 500,
						background: "var(--vscode-button-background, #0078d4)",
						color: "var(--vscode-button-foreground, #fff)",
						minWidth: 0,
						margin: 0,
					}}>
					{loading ? "Refreshing…" : "Refresh"}
				</VSCodeButton>
			</div>
			{lastRefreshedText ? (
				<div className="text-[11px] text-[var(--vscode-descriptionForeground)] mt-0 mb-2">
					Last refreshed at {lastRefreshedText}
				</div>
			) : null}
		</div>
	)
}

export default OcaVectorPicker

interface MultiSelectDropdownProps {
	className?: string
	id?: string
	options: {
		id: string
		name: string
	}[]
	selectedIds: string[]
	toggleOption: (option: { id: string; name: string }) => Promise<void>
}

const MultiSelectDropdown: React.FC<MultiSelectDropdownProps> = ({ options, selectedIds, toggleOption, className, id }) => {
	const [open, setOpen] = useState<boolean>(false)
	const wrapperRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		function handleClickOutside(event: MouseEvent) {
			if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
				setOpen(false)
			}
		}
		document.addEventListener("mousedown", handleClickOutside)
		return () => document.removeEventListener("mousedown", handleClickOutside)
	}, [])

	const selectedLabel =
		selectedIds.length === 0 || options.length === 0
			? "Select options..."
			: selectedIds.map((selectedId) => options.filter((option) => selectedId === option.id)[0].name).join(", ")

	return (
		<div
			className={className}
			id={id}
			ref={wrapperRef}
			style={{
				position: "relative",
				width: "100%",
				minWidth: 0,
				height: "100%",
				zIndex: 100,
			}}>
			{/* VSCode style dropdown button */}
			<div
				aria-disabled={options.length == 0}
				aria-expanded={open}
				aria-haspopup="listbox"
				onClick={() => options.length > 0 && setOpen((o) => !o)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						setOpen(false)
					}
					if ((e.key === " " || e.key === "Enter") && options.length > 0) {
						setOpen((o) => !o)
					}
				}}
				style={{
					display: "flex",
					alignItems: "center",
					position: "absolute",
					top: 0,
					left: 0,
					bottom: 0,
					right: 0,
					minHeight: "100%",
					border: "1px solid var(--vscode-dropdown-border, #3c3c3c)",
					borderRadius: "calc(var(--corner-radius-round) * 1px)",
					background: "var(--vscode-dropdown-background, #1e1e1e)",
					color: "var(--vscode-dropdown-foreground, #cccccc)",
					minWidth: 0,
					padding: "2px 6px 2px 8px",
					cursor: options.length == 0 ? "not-allowed" : "pointer",
					fontSize: 12,
					fontFamily: "var(--vscode-font-family, inherit)",
					boxSizing: "border-box",
					outline: open ? "2px solid var(--vscode-focusBorder, #0078d4)" : "none",
					margin: 0,
					opacity: options.length == 0 ? 0.6 : 1,
				}}
				tabIndex={0}>
				<span
					style={{
						overflow: "hidden",
						height: "100%",
						whiteSpace: "nowrap",
						textOverflow: "ellipsis",
						userSelect: "none",
						flex: 1,
					}}
					title={selectedLabel}>
					{selectedLabel}
				</span>
				<svg
					className="select-indicator"
					fill="currentColor"
					height="16"
					style={{}}
					viewBox="0 0 16 16"
					width="16"
					xmlns="http://www.w3.org/2000/svg">
					<path
						clip-rule="evenodd"
						d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"
						fill-rule="evenodd"></path>
				</svg>
			</div>

			{open && (
				<div
					role="listbox"
					style={{
						position: "absolute",
						top: "100%",
						left: 0,
						right: 0,
						zIndex: 1000,
						background: "var(--vscode-dropdown-background, #1e1e1e)",
						border: "1px solid var(--vscode-dropdown-border, #3c3c3c)",
						borderRadius: "calc(var(--corner-radius-round) * 1px)",
						boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
						color: "var(--vscode-dropdown-foreground, #cccccc)",
						fontSize: 13,
						fontFamily: "inherit",
						padding: 4,
						maxHeight: "100px",
						overflowY: "auto",
						margin: 0,
						marginTop: 2,
					}}>
					{options.map((option) => {
						const checked = selectedIds.includes(option.id)
						return (
							<div
								aria-selected={checked}
								key={option.id}
								onClick={async (e) => {
									e.stopPropagation()
									await toggleOption(option)
								}}
								onKeyDown={async (e) => {
									if (e.key === " " || e.key === "Enter") {
										await toggleOption(option)
									}
								}}
								role="option"
								style={{
									display: "flex",
									alignItems: "center",
									padding: "4px 8px",
									margin: 0,
									borderRadius: 3,
									cursor: "pointer",
									background: checked ? "var(--vscode-list-activeSelectionBackground, #094771)" : "transparent",
									color: checked
										? "var(--vscode-list-activeSelectionForeground, #fff)"
										: "var(--vscode-dropdown-foreground, #cccccc)",
								}}
								tabIndex={0}>
								<input
									checked={checked}
									readOnly
									style={{
										accentColor: "var(--vscode-checkbox-foreground, #0078d4)",
										marginRight: 8,
									}}
									tabIndex={-1}
									type="checkbox"
								/>
								<span
									style={{
										flex: 1,
										fontSize: 12,
										fontFamily: "inherit",
									}}>
									{option.name}
								</span>
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}
