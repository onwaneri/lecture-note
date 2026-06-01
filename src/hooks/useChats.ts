import { useCallback, useEffect, useRef, useState } from 'react'
import { getAllChatsForFile, setChat, type ChatTurnRecord } from '../lib/db'

export type ConversationTurn = ChatTurnRecord

export interface UseChatsResult {
  /** The persisted conversation for a slide ([] if none). */
  getChat: (slideIndex: number) => ConversationTurn[]
  /** Replace a slide's conversation and persist it (debounced). */
  updateChat: (slideIndex: number, turns: ConversationTurn[]) => void
  ready: boolean
}

const SAVE_DEBOUNCE_MS = 400
const EMPTY: ConversationTurn[] = []

export function useChats(filename: string | null): UseChatsResult {
  const [chats, setChats] = useState<Map<number, ConversationTurn[]>>(new Map())
  const [ready, setReady] = useState(false)
  const pendingTimers = useRef<Map<number, number>>(new Map())

  useEffect(() => {
    let cancelled = false
    setReady(false)
    setChats(new Map())
    if (!filename) {
      setReady(true)
      return
    }
    getAllChatsForFile(filename).then((loaded) => {
      if (cancelled) return
      setChats(loaded)
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [filename])

  const getChat = useCallback(
    (slideIndex: number): ConversationTurn[] => chats.get(slideIndex) ?? EMPTY,
    [chats],
  )

  const updateChat = useCallback(
    (slideIndex: number, turns: ConversationTurn[]) => {
      if (!filename) return
      setChats((prev) => {
        const next = new Map(prev)
        if (turns.length === 0) next.delete(slideIndex)
        else next.set(slideIndex, turns)
        return next
      })
      const prior = pendingTimers.current.get(slideIndex)
      if (prior !== undefined) window.clearTimeout(prior)
      const timer = window.setTimeout(() => {
        setChat(filename, slideIndex, turns).catch((e) => {
          console.error('failed to persist chat', e)
        })
        pendingTimers.current.delete(slideIndex)
      }, SAVE_DEBOUNCE_MS)
      pendingTimers.current.set(slideIndex, timer)
    },
    [filename],
  )

  useEffect(() => {
    return () => {
      for (const t of pendingTimers.current.values()) window.clearTimeout(t)
      pendingTimers.current.clear()
    }
  }, [])

  return { getChat, updateChat, ready }
}
