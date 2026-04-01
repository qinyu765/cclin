/**
 * @file ChatTimeline 状态管理器 — useReducer 模式。
 *
 * 替代 App 中的 useState + setTimeline，提供类型安全的 action 分发。
 * 参考 memo-code/packages/tui/src/state/chat_timeline.ts 设计。
 */

import { TOOL_STATUS } from '../types.js'
import type {
    StepView,
    SystemMessage,
    SystemMessageTone,
    ToolAction,
    ToolStatus,
    TurnView,
} from '../types.js'

// ─── State ────────────────────────────────────────────────────────────────

export type ChatTimelineState = {
    turns: TurnView[]
    systemMessages: SystemMessage[]
    sequence: number
}

// ─── Actions ──────────────────────────────────────────────────────────────

export type ChatTimelineAction =
    | {
          type: 'append_system_message'
          title: string
          content: string
          tone?: SystemMessageTone
      }
    | { type: 'turn_start'; turn: number; input: string }
    | {
          type: 'assistant_chunk'
          turn: number
          step: number
          chunk: string
      }
    | {
          type: 'tool_action'
          turn: number
          step: number
          action: ToolAction
          thinking?: string
      }
    | {
          type: 'tool_observation'
          turn: number
          step: number
          observation: string
          toolStatus: ToolStatus
      }
    | {
          type: 'turn_final'
          turn: number
          finalText: string
          status: 'ok' | 'error' | 'cancelled'
          errorMessage?: string
      }
    | { type: 'clear_all' }

// ─── Helpers ──────────────────────────────────────────────────────────────

export function createInitialState(): ChatTimelineState {
    return { turns: [], systemMessages: [], sequence: 0 }
}

function createEmptyTurn(
    index: number,
    sequence: number,
): TurnView {
    return { index, userInput: '', steps: [], sequence }
}

function ensureStep(steps: StepView[], step: number): StepView[] {
    if (steps.length > step) return steps
    const next = steps.slice()
    while (next.length <= step) {
        next.push({ index: next.length, assistantText: '' })
    }
    return next
}

function upsertTurn(
    state: ChatTimelineState,
    turn: number,
    updater: (tv: TurnView) => TurnView,
): { turns: TurnView[]; sequence: number } {
    const turns = state.turns.slice()
    const idx = turns.findIndex((t) => t.index === turn)
    if (idx === -1) {
        const seq = state.sequence + 1
        turns.push(updater(createEmptyTurn(turn, seq)))
        return { turns, sequence: seq }
    }
    const existing = turns[idx]
    if (!existing) return { turns, sequence: state.sequence }
    turns[idx] = updater(existing)
    return { turns, sequence: state.sequence }
}

// ─── Reducer ──────────────────────────────────────────────────────────────

export function chatTimelineReducer(
    state: ChatTimelineState,
    action: ChatTimelineAction,
): ChatTimelineState {
    switch (action.type) {
        case 'append_system_message': {
            const sequence = state.sequence + 1
            return {
                ...state,
                sequence,
                systemMessages: [
                    ...state.systemMessages,
                    {
                        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                        title: action.title,
                        content: action.content,
                        tone: action.tone ?? 'info',
                        sequence,
                    },
                ],
            }
        }

        case 'turn_start': {
            const u = upsertTurn(state, action.turn, (tv) => ({
                ...tv,
                userInput: action.input,
                steps: [],
                finalText: undefined,
                status: 'running' as const,
                errorMessage: undefined,
            }))
            return { ...state, turns: u.turns, sequence: u.sequence }
        }

        case 'assistant_chunk': {
            const u = upsertTurn(state, action.turn, (tv) => {
                const steps = ensureStep(tv.steps, action.step)
                const cur = steps[action.step]
                if (!cur) return tv
                steps[action.step] = {
                    ...cur,
                    assistantText: `${cur.assistantText}${action.chunk}`,
                }
                return { ...tv, steps }
            })
            return { ...state, turns: u.turns, sequence: u.sequence }
        }

        case 'tool_action': {
            const u = upsertTurn(state, action.turn, (tv) => {
                const steps = ensureStep(tv.steps, action.step)
                const cur = steps[action.step]
                if (!cur) return tv
                steps[action.step] = {
                    ...cur,
                    action: action.action,
                    thinking: action.thinking,
                    toolStatus: TOOL_STATUS.EXECUTING,
                }
                return { ...tv, steps }
            })
            return { ...state, turns: u.turns, sequence: u.sequence }
        }

        case 'tool_observation': {
            const u = upsertTurn(state, action.turn, (tv) => {
                const steps = ensureStep(tv.steps, action.step)
                const cur = steps[action.step]
                if (!cur) return tv
                steps[action.step] = {
                    ...cur,
                    observation: action.observation,
                    toolStatus: action.toolStatus,
                }
                return { ...tv, steps }
            })
            return { ...state, turns: u.turns, sequence: u.sequence }
        }

        case 'turn_final': {
            const u = upsertTurn(state, action.turn, (tv) => ({
                ...tv,
                finalText: action.finalText,
                status: action.status,
                errorMessage: action.errorMessage,
            }))
            return { ...state, turns: u.turns, sequence: u.sequence }
        }

        case 'clear_all':
            return createInitialState()

        default:
            return state
    }
}
