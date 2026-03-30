import type { ApiConfiguration } from "@shared/api"
import { VectorStoreInfo } from "@shared/proto/index.cline"
import { Mode } from "@shared/storage/types"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { normalizeApiConfiguration } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

export interface OcaVectorPickerProps {
	apiConfiguration: ApiConfiguration | undefined
	currentMode: Mode
	ocaKbs: Record<string, VectorStoreInfo>
	onRefresh: () => void | Promise<void>
	loading?: boolean
	lastRefreshedAt?: number | null
	disabled?: boolean
	disabledMessage?: string
}

export const OcaVectorPicker: React.FC<OcaVectorPickerProps> = ({
	apiConfiguration,
	currentMode,
	ocaKbs,
	onRefresh,
	loading,
	lastRefreshedAt,
	disabled = false,
	disabledMessage,
}: OcaVectorPickerProps) => {
	const { handleModeFieldChange } = useApiConfigurationHandlers()

	const handleKbChange = async (kbs: string[]) => {
		if (disabled) {
			return
		}
		await handleModeFieldChange({ plan: "planModeOcaVectorIds", act: "actModeOcaVectorIds" }, kbs, currentMode)
	}

	const handleRefreshToken = async () => {
		if (disabled) {
			return
		}
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
		if (disabled) {
			return
		}
		const prevVectorIds = selectedVectorIds || []
		const newVectorIds = prevVectorIds.includes(option.id)
			? prevVectorIds.filter((o) => o !== option.id)
			: [...prevVectorIds, option.id]
		await handleKbChange(newVectorIds)
	}

	return (
		<div className="w-full mt-[10px]">
			<style>{`
				#oca-vector-picker-trigger-listbox {
					max-height: 120px;
					overflow: auto;
				}
			`}</style>
			<label className="font-medium text-[12px] mb-[4px] block" htmlFor="oca-vector-picker-trigger">
				Knowledge Base
			</label>
			{disabled && disabledMessage ? (
				<div className="text-[11px] text-[var(--vscode-errorForeground)] mt-1 mb-2">{disabledMessage}</div>
			) : null}
			<div className="flex items-center gap-2 mb-1">
				<MultiSelectDropdown
					buttonId="oca-vector-picker-trigger"
					className="flex-1 text-[12px] min-h-[24px]"
					disabled={disabled || kbIds.length === 0}
					emptyLabel={kbIds.length === 0 ? "No knowledge bases found" : undefined}
					loading={!!loading}
					options={kbIds.map((kbId) => ({
						id: kbId,
						name: ocaKbs[kbId].name,
					}))}
					selectedIds={selectedVectorIds || []}
					toggleOption={toggleOption}
				/>
				<VSCodeButton
					disabled={!!loading || disabled}
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

interface MultiSelectDropdownProps {
	buttonId?: string
	className?: string
	disabled?: boolean
	emptyLabel?: string
	loading?: boolean
	options: {
		id: string
		name: string
	}[]
	selectedIds: string[]
	toggleOption: (option: { id: string; name: string }) => Promise<void>
}

const MultiSelectDropdown: React.FC<MultiSelectDropdownProps> = ({
	buttonId,
	className,
	disabled = false,
	emptyLabel,
	loading = false,
	options,
	selectedIds,
	toggleOption,
}) => {
	const triggerId = buttonId || useId()
	const listboxId = `${triggerId}-listbox`
	const wrapperRef = useRef<HTMLDivElement>(null)
	const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
	const [open, setOpen] = useState(false)
	const [activeIndex, setActiveIndex] = useState<number>(-1)

	const hasOptions = options.length > 0
	const isInteractive = hasOptions && !disabled

	const selectedNames = useMemo(() => {
		if (!selectedIds.length) {
			return []
		}
		return selectedIds
			.map((selectedId) => options.find((option) => option.id === selectedId)?.name)
			.filter((name): name is string => Boolean(name))
	}, [options, selectedIds])

	const selectionSummary = useMemo(() => {
		if (!hasOptions) {
			return emptyLabel ?? "No data"
		}
		if (!selectedNames.length) {
			return "Select knowledge bases"
		}
		if (selectedNames.length <= 2) {
			return selectedNames.join(", ")
		}
		return `${selectedNames.slice(0, 2).join(", ")} +${selectedNames.length - 2} more`
	}, [emptyLabel, hasOptions, selectedNames])

	const closeDropdown = useCallback(() => {
		setOpen(false)
		setActiveIndex(-1)
	}, [])

	const openDropdown = useCallback(() => {
		if (!isInteractive) {
			return
		}
		setOpen(true)
		const firstSelectedIndex = selectedIds.length ? options.findIndex((option) => option.id === selectedIds[0]) : 0
		setActiveIndex(firstSelectedIndex >= 0 ? firstSelectedIndex : 0)
	}, [isInteractive, options, selectedIds])

	useEffect(() => {
		if (!open) {
			return
		}
		const handleClickOutside = (event: MouseEvent) => {
			if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
				closeDropdown()
			}
		}
		document.addEventListener("mousedown", handleClickOutside)
		return () => {
			document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [closeDropdown, open])

	useEffect(() => {
		if (!open || activeIndex < 0) {
			return
		}
		optionRefs.current[activeIndex]?.focus({ preventScroll: false })
	}, [activeIndex, open])

	const handleToggleOption = useCallback(
		async (index: number) => {
			const option = options[index]
			if (!option) {
				return
			}
			await toggleOption(option)
		},
		[options, toggleOption],
	)

	const handleTriggerKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLButtonElement>) => {
			if (!isInteractive) {
				return
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault()
				openDropdown()
			}
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault()
				setOpen((prev) => {
					if (!prev) {
						openDropdown()
						return true
					}
					closeDropdown()
					return false
				})
			}
		},
		[closeDropdown, isInteractive, openDropdown],
	)

	const handleListKeyDown = useCallback(
		async (event: React.KeyboardEvent<HTMLDivElement>) => {
			if (event.key === "Escape") {
				event.preventDefault()
				closeDropdown()
				return
			}
			if (event.key === "Tab") {
				closeDropdown()
				return
			}
			if (event.key === "ArrowDown") {
				event.preventDefault()
				setActiveIndex((prev) => (prev + 1) % options.length)
				return
			}
			if (event.key === "ArrowUp") {
				event.preventDefault()
				setActiveIndex((prev) => (prev - 1 + options.length) % options.length)
				return
			}
			if (event.key === "Home") {
				event.preventDefault()
				setActiveIndex(0)
				return
			}
			if (event.key === "End") {
				event.preventDefault()
				setActiveIndex(options.length - 1)
				return
			}
			if (event.key === " " || event.key === "Enter") {
				event.preventDefault()
				if (activeIndex >= 0) {
					await handleToggleOption(activeIndex)
				}
			}
		},
		[activeIndex, closeDropdown, handleToggleOption, options.length],
	)

	return (
		<div className={`relative ${className ?? ""}`} ref={wrapperRef}>
			<button
				aria-controls={listboxId}
				aria-disabled={!isInteractive}
				aria-expanded={open}
				aria-haspopup="listbox"
				className={`flex w-full min-h-[28px] items-center gap-2 rounded-[var(--corner-radius-round)] border border-[var(--vscode-dropdown-border,#3c3c3c)] bg-[var(--vscode-dropdown-background,#1e1e1e)] px-2 py-[2px] text-left text-[12px] leading-[18px] text-[var(--vscode-dropdown-foreground,#cccccc)] transition-[outline] ${
					isInteractive ? "cursor-pointer" : "cursor-not-allowed opacity-60"
				}`}
				disabled={!isInteractive}
				id={triggerId}
				onClick={() => (open ? closeDropdown() : openDropdown())}
				onKeyDown={handleTriggerKeyDown}
				type="button">
				<span className="flex-1 truncate" title={selectionSummary}>
					{selectionSummary}
				</span>
				{loading ? (
					<span className="text-[11px] text-[var(--vscode-descriptionForeground)]">Loading…</span>
				) : (
					<svg
						aria-hidden
						className="h-4 w-4 flex-shrink-0"
						fill="currentColor"
						viewBox="0 0 16 16"
						xmlns="http://www.w3.org/2000/svg">
						<path
							clipRule="evenodd"
							d="M7.976 10.072 12.333 5.715l.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z"
							fillRule="evenodd"
						/>
					</svg>
				)}
			</button>

			{open && (
				<div
					aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${options[activeIndex]?.id}` : undefined}
					aria-labelledby={triggerId}
					className="absolute left-0 right-0 z-50 mt-1 max-h-[160px] overflow-y-auto rounded-[var(--corner-radius-round)] border border-[var(--vscode-dropdown-border,#3c3c3c)] bg-[var(--vscode-dropdown-background,#1e1e1e)] shadow-[0_4px_20px_rgba(0,0,0,0.35)]"
					id={listboxId}
					onKeyDown={handleListKeyDown}
					role="listbox"
					tabIndex={-1}>
					{!hasOptions ? (
						<div className="px-3 py-2 text-[12px] text-[var(--vscode-descriptionForeground)]" role="presentation">
							{emptyLabel ?? "No knowledge bases available"}
						</div>
					) : (
						options.map((option, index) => {
							const checked = selectedIds.includes(option.id)
							const isActive = index === activeIndex
							return (
								<button
									aria-checked={checked}
									className={`flex w-full items-center gap-2 px-3 py-[6px] text-left text-[12px] leading-[18px] ${
										checked
											? "bg-[var(--vscode-list-activeSelectionBackground,#094771)] text-[var(--vscode-list-activeSelectionForeground,#ffffff)]"
											: isActive
												? "bg-[var(--vscode-list-hoverBackground,#2a2d2e)]"
												: "bg-transparent text-[var(--vscode-dropdown-foreground,#cccccc)]"
									}`}
									id={`${listboxId}-${option.id}`}
									key={option.id}
									onClick={async (event) => {
										event.preventDefault()
										await handleToggleOption(index)
									}}
									onMouseEnter={() => setActiveIndex(index)}
									onMouseLeave={() => setActiveIndex((prev) => (prev === index ? -1 : prev))}
									ref={(el) => {
										optionRefs.current[index] = el
									}}
									role="option"
									tabIndex={-1}
									type="button">
									<span
										className={`flex h-3 w-3 items-center justify-center rounded-[3px] border text-[10px] font-semibold ${
											checked
												? "border-[var(--vscode-checkbox-border,#0078d4)] bg-[var(--vscode-checkbox-background,#0078d4)] text-black"
												: "border-[var(--vscode-checkbox-border,#3c3c3c)] text-transparent"
										}`}>
										✓
									</span>
									<span className="flex-1 truncate" title={option.name}>
										{option.name}
									</span>
								</button>
							)
						})
					)}
				</div>
			)}
		</div>
	)
}

export default OcaVectorPicker
