'use client'

import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { latestPerFamily } from '@/lib/ai/model-families'
import { useAppFetch } from '@/components/app-runtime'
import type { AIEffort } from '@/lib/ai/types'

/** Domains the Analyst can be scoped to that have no id of their own (unlike a company or deal). */
export type AnalystDomain = 'lps' | 'diligence'

interface AnalystModel {
  id: string
  name: string
  provider: string
}

export interface ConversationListItem {
  id: string
  title: string
  company_id: string | null
  deal_id: string | null
  message_count: number
  created_at: string
  updated_at: string
}

interface AnalystContextValue {
  open: boolean
  toggleOpen: () => void
  close: () => void
  messages: { role: 'user' | 'assistant'; content: string }[]
  setMessages: React.Dispatch<React.SetStateAction<{ role: 'user' | 'assistant'; content: string }[]>>
  companyId: string | null
  setCompanyId: (id: string | null) => void
  dealId: string | null
  setDealId: (id: string | null) => void
  /** Accounting scope (portfolio_group) — set by the funds pages, null everywhere else. The
   *  server decides whether the user may actually have accounting; this only says where they are. */
  vehicle: string | null
  setVehicle: (group: string | null) => void
  /** Which section the user is in, for domains with no id of their own. Same deal: this reports
   *  where they are, it doesn't assert what they may see. */
  domain: AnalystDomain | null
  setDomain: (domain: AnalystDomain | null) => void
  selectedModel: AnalystModel | null
  setSelectedModel: (model: AnalystModel | null) => void
  availableModels: AnalystModel[]
  /** Thinking effort for the next question. Sent with every request; the server drops it for
   *  models without the knob. */
  effort: AIEffort
  setEffort: (effort: AIEffort) => void
  /** Loads the model list if it isn't loaded yet. Safe to call on every mount. */
  ensureModels: () => Promise<void>
  fundName: string
  hasAIKey: boolean
  conversationId: string | null
  setConversationId: (id: string | null) => void
  conversations: ConversationListItem[]
  loadConversations: () => Promise<void>
  loadConversation: (id: string) => Promise<void>
  startNewConversation: () => void
  deleteConversation: (id: string) => Promise<void>
  showHistory: boolean
  setShowHistory: (show: boolean) => void
  /** Open the Analyst with a question typed into its input, for the user to review and send. */
  ask: (question: string) => void
  /** The question waiting to be put in the input (consumed by the conversation view). */
  prefill: string | null
  clearPrefill: () => void
}

const AnalystContext = createContext<AnalystContextValue | null>(null)

export function AnalystProvider({
  hasAIKey,
  configuredProviders,
  defaultAIProvider,
  fundName,
  children,
}: {
  hasAIKey: boolean
  configuredProviders: string[]
  defaultAIProvider: string
  fundName: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [companyId, setCompanyIdState] = useState<string | null>(null)
  const [dealId, setDealIdState] = useState<string | null>(null)
  const [vehicle, setVehicleState] = useState<string | null>(null)
  const [domain, setDomainState] = useState<AnalystDomain | null>(null)
  const [availableModels, setAvailableModels] = useState<AnalystModel[]>([])
  const [selectedModel, setSelectedModel] = useState<AnalystModel | null>(null)
  const [effort, setEffort] = useState<AIEffort>('high')
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [conversations, setConversations] = useState<ConversationListItem[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const appFetch = useAppFetch()

  const toggleOpen = useCallback(() => setOpen(prev => !prev), [])
  const close = useCallback(() => setOpen(false), [])
  const [prefill, setPrefill] = useState<string | null>(null)
  const ask = useCallback((question: string) => { setPrefill(question); setOpen(true) }, [])
  const clearPrefill = useCallback(() => setPrefill(null), [])

  // Reset conversation state when companyId changes
  const setCompanyId = useCallback((id: string | null) => {
    setCompanyIdState(prev => {
      if (prev !== id) {
        setMessages([])
        setConversationId(null)
        setShowHistory(false)
        setConversations([])
        // Switching to/from a company scope clears any deal scope.
        setDealIdState(null)
      }
      return id
    })
  }, [])

  // Reset conversation state when dealId changes
  const setDealId = useCallback((id: string | null) => {
    setDealIdState(prev => {
      if (prev !== id) {
        setMessages([])
        setConversationId(null)
        setShowHistory(false)
        setConversations([])
        // Switching into a deal scope clears any company scope.
        if (id) setCompanyIdState(null)
      }
      return id
    })
  }, [])

  // Switching vehicles switches which books the Analyst is looking at, so the thread starts over.
  const setVehicle = useCallback((group: string | null) => {
    setVehicleState(prev => {
      if (prev !== group) {
        setMessages([])
        setConversationId(null)
        setShowHistory(false)
        setConversations([])
      }
      return group
    })
  }, [])

  // Likewise moving between domains — an LP thread and a diligence thread are different threads.
  const setDomain = useCallback((next: AnalystDomain | null) => {
    setDomainState(prev => {
      if (prev !== next) {
        setMessages([])
        setConversationId(null)
        setShowHistory(false)
        setConversations([])
      }
      return next
    })
  }, [])

  const loadConversations = useCallback(async () => {
    const params = new URLSearchParams()
    if (dealId) {
      params.set('dealId', dealId)
    } else if (companyId) {
      params.set('companyId', companyId)
    } else {
      params.set('portfolio', 'true')
      // Mirrors the scope key the server stores (see /api/analyst). A user who turns out not to be
      // entitled to the domain simply has no threads under it.
      const scope = vehicle ? `accounting:${vehicle}` : domain
      if (scope) params.set('scope', scope)
    }
    try {
      const res = await appFetch(`/api/analyst/conversations?${params}`)
      if (res.ok) {
        const data = await res.json()
        setConversations(data.conversations ?? [])
      }
    } catch {
      // Silently fail
    }
  }, [companyId, dealId, vehicle, domain, appFetch])

  const loadConversation = useCallback(async (id: string) => {
    try {
      const res = await appFetch(`/api/analyst/conversations/${id}`)
      if (res.ok) {
        const data = await res.json()
        const conv = data.conversation
        setConversationId(conv.id)
        setMessages(Array.isArray(conv.messages) ? conv.messages : [])
        setShowHistory(false)
      }
    } catch {
      // Silently fail
    }
  }, [appFetch])

  const startNewConversation = useCallback(() => {
    setMessages([])
    setConversationId(null)
    setShowHistory(false)
  }, [])

  const deleteConversation = useCallback(async (id: string) => {
    try {
      const res = await appFetch(`/api/analyst/conversations/${id}`, { method: 'DELETE' })
      if (res.ok) {
        setConversations(prev => prev.filter(c => c.id !== id))
        if (conversationId === id) {
          setMessages([])
          setConversationId(null)
        }
      }
    } catch {
      // Silently fail
    }
  }, [conversationId, appFetch])

  // Models are fetched lazily, but "lazily" used to mean "when the side panel opens" — which is
  // why the model picker was missing on /start: that page never opens the panel, so the list
  // stayed empty and the picker rendered nothing. The trigger is now an explicit call any surface
  // that shows a picker can make, and it is idempotent: an in-flight or completed fetch is not
  // repeated.
  const modelsRequested = useRef(false)

  const ensureModels = useCallback(async () => {
    if (!hasAIKey || modelsRequested.current) return
    modelsRequested.current = true

    const providerEndpoints: { provider: string; url: string }[] = [
      { provider: 'anthropic', url: '/api/claude-models' },
      { provider: 'openai', url: '/api/openai-models' },
    ].filter(p => configuredProviders.includes(p.provider))

    const results = await Promise.allSettled(
      providerEndpoints.map(p => appFetch(p.url).then(r => r.json()))
    )

    const models: AnalystModel[] = []
    results.forEach((res, i) => {
      if (res.status === 'fulfilled' && Array.isArray(res.value.models)) {
        for (const m of res.value.models) {
          models.push({ id: m.id, name: m.name, provider: providerEndpoints[i].provider })
        }
      }
    })

    // A failed fetch should not be permanent — let the next surface that needs the list retry.
    if (models.length === 0) modelsRequested.current = false
    // The picker offers the newest of each family — Opus, Sonnet, Haiku — not every dated
    // snapshot and superseded version the provider still serves.
    setAvailableModels(latestPerFamily(models))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasAIKey, configuredProviders.join(','), appFetch])

  useEffect(() => {
    if (open) void ensureModels()
  }, [open, ensureModels])

  return (
    <AnalystContext.Provider value={{
      open,
      toggleOpen,
      close,
      messages,
      setMessages,
      companyId,
      setCompanyId,
      dealId,
      setDealId,
      vehicle,
      setVehicle,
      domain,
      setDomain,
      selectedModel,
      setSelectedModel,
      availableModels,
      effort,
      setEffort,
      ensureModels,
      fundName,
      hasAIKey,
      conversationId,
      setConversationId,
      conversations,
      loadConversations,
      loadConversation,
      startNewConversation,
      deleteConversation,
      showHistory,
      setShowHistory,
      ask,
      prefill,
      clearPrefill,
    }}>
      {children}
    </AnalystContext.Provider>
  )
}

export function useAnalystContext() {
  const ctx = useContext(AnalystContext)
  if (!ctx) throw new Error('useAnalystContext must be used within AnalystProvider')
  return ctx
}
