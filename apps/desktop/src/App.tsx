import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Sidebar } from '@/components/Sidebar'
import type { View } from '@/components/Sidebar'
import { QueuePane } from '@/components/QueuePane'
import { DetailPane } from '@/components/DetailPane'
import { ChatPane } from '@/components/ChatPane'
import { CalendarPane } from '@/components/CalendarPane'
import { IntegrationsModal } from '@/components/IntegrationsModal'
import { SettingsPane } from '@/components/SettingsPane'
import { FilesPane } from '@/components/FilesPane'
import { SkillsPane } from '@/components/SkillsPane'
import { TeamPane } from '@/components/TeamPane'
import { CanvasPane } from '@/components/CanvasPane'
import { OnboardingTour } from '@/components/OnboardingTour'
import { OnboardingActivation } from '@/components/OnboardingActivation'
import { QueueToast } from '@/components/QueueToast'
import { QueueDrawer } from '@/components/QueueDrawer'
import { useAgent } from '@/hooks/useAgent'
import { useUpdater } from '@/hooks/useUpdater'
import { useTheme } from '@/hooks/useTheme'
import { registerVoiceHotkey, unregisterVoiceHotkey, cancelVoice, setTtsVolume } from '@/lib/voice'
import { setVoiceActive } from '@/hooks/useAgent'
import { primeKernelPool, sweepIdleWorkers } from '@/python/python-kernel'
import { emit } from '@tauri-apps/api/event'
import { open } from '@tauri-apps/plugin-shell'
import type { ApprovalItem } from '@coagent/shared'

function ConnectingOverlay({ visible }: { visible: boolean }) {
  const [show, setShow] = React.useState(true)
  React.useEffect(() => {
    if (!visible) {
      // Keep mounted for 1 extra frame so app renders beneath before unmount
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setShow(false)))
      return () => cancelAnimationFrame(id)
    }
  }, [visible])
  if (!show) return null
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-white dark:bg-neutral-950 gap-4 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.035] dark:opacity-[0.04]"
        style={{
          backgroundImage: `linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)`,
          backgroundSize: '40px 40px',
        }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_transparent_30%,_var(--background)_70%)]" />
      <img src="/coagent-logo.png" alt="Co-Agent" className="relative w-16 h-16 opacity-30 invert contrast-[3] mix-blend-multiply dark:invert-0 dark:contrast-[3] dark:mix-blend-screen" />
      <div className="relative w-6 h-6 border-2 border-neutral-200 dark:border-neutral-700 border-t-neutral-900 dark:border-t-neutral-100 rounded-full animate-spin" />
      <p className="relative text-[12px] text-neutral-400 dark:text-neutral-600">Connecting...</p>
    </div>
  )
}

export default function App() {
  const { queue, done, newQueueIds, messages, streamingText, thinking, processing, toolLabel, researchAgents, connected, hydrated, lastHeartbeat, heartbeatLog, triggerHeartbeat, statusLine, skills, updateSkill, deleteSkill, steer, stopAgent, integrations, error, chat, approve, reject, editQueueItem, dismissQueueToast, connectIntegration, disconnectIntegration, settings, updateSettings, authStatus, updateAuth, verifyAuth, files, folders, searchResults, transcribingFiles, ingestFile, deleteFile, ingestFilePaths, createFolder, moveFile, renameFile, renameFolder, deleteFolder, reorderFolders, moveFolder, searchFilesUI, relayActive, relayModel, setRelayModel, relayUsage, activateRelay, refreshRelayStatus, pendingFields, setPendingFields, setModel, usage, refreshUsage, organizing, autoOrganize, calendarEntries, completeCalendarEntry, deleteCalendarEntry, googleCalendarStatus, googleCalendarConnect, googleCalendarDisconnect, googleCalendarToggle, googleCalendarColor, googleCalendarSync, capabilityCard, confirmCapabilities, deleteCustomIntegration, whatsappQr, toggleTrigger, getRelayCredentials, relayCredentials, isAdmin, adminUsers, adminNewToken, clearAdminNewToken, adminCreateToken, adminListTokens, adminRevokeToken, teamInfo, teamMessages, teamStatus, sendTeamMessage, triggerPrompt, setTriggerPrompt, canvas, canvasVisible, canvasStreaming, canvasStreamingCode, openCanvas, closeCanvas, canvasesList, getCanvases, codeCells, codeCellOrder, cancelCodeCell, exportPdf, enableWakeScheduling } = useAgent()
  const { dark, toggle: toggleTheme } = useTheme()
  const updater = useUpdater()
  const [view, setView] = useState<View>('chat')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const selectedItem = selectedItemId ? queue.find(i => i.id === selectedItemId) ?? null : null
  const setSelectedItem = useCallback((item: ApprovalItem | null) => setSelectedItemId(item?.id ?? null), [])
  const [modalOpen, setModalOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [activated, setActivated] = useState(() => !!localStorage.getItem('coagent-token'))
  const [activationFading, setActivationFading] = useState(false)
  // Wait for WebSocket to connect before showing activation gate.
  // If already activated from localStorage, skip the wait entirely.
  const [wsChecked, setWsChecked] = useState(() => !!localStorage.getItem('coagent-token'))
  const [tourDone, setTourDone] = useState(() => localStorage.getItem('tourDone') === '1')
  const markTourDone = useCallback((done: boolean) => { setTourDone(done); if (done) localStorage.setItem('tourDone', '1') }, [])
  const newQueueItems = useMemo(() => queue.filter(i => newQueueIds.has(i.id) && i.status === 'pending'), [queue, newQueueIds])

  // Partner state
  const RELAY_URL = (import.meta.env.VITE_RELAY_URL as string).replace(/\/$/, '')
  const [partnerStats, setPartnerStats] = useState<{ referralCode?: string; tier?: string; commissionRate?: number; stripeConnectId?: string; accruedCommission?: number } | null>(null)

  useEffect(() => {
    const token = localStorage.getItem('coagent-token')
    if (!token || token === 'existing') return
    fetch(`${RELAY_URL}/partner/stats`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setPartnerStats(data) })
      .catch(() => {})
  }, [activated])

  const handleSetupPayouts = useCallback(async () => {
    const token = localStorage.getItem('coagent-token')
    if (!token) return
    try {
      const res = await fetch(`${RELAY_URL}/partner/connect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      })
      const data = await res.json() as any
      if (data.url) {
        await open(data.url)
        // Refresh stats after a delay to pick up the Connect ID
        setTimeout(() => {
          fetch(`${RELAY_URL}/partner/stats`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.ok ? r.json() : null)
            .then(d => { if (d) setPartnerStats(d) })
            .catch(() => {})
        }, 5000)
      }
    } catch (e) {
      console.error('[Partner] Connect failed:', e)
    }
  }, [])

  // Mark as activated if relay credentials are already present (existing users)
  useEffect(() => {
    if (relayCredentials && !activated) {
      localStorage.setItem('coagent-token', 'existing')
      setActivated(true)
      setWsChecked(true)
    }
  }, [relayCredentials, activated])

  // Once WebSocket connects (or fails after timeout), mark as checked
  useEffect(() => {
    if (wsChecked) return
    if (connected) { setWsChecked(true); return }
    const t = setTimeout(() => setWsChecked(true), 2000)
    return () => clearTimeout(t)
  }, [connected, wsChecked])


  // ESC to cancel voice/stop agent — always fire both regardless of state
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelVoice()
        stopAgent()
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [stopAgent])

  // Python kernel: prime one Pyodide worker on app launch so the first
  // run_python call has no cold-start latency. Sweep idle workers periodically.
  useEffect(() => {
    primeKernelPool()
    const interval = setInterval(sweepIdleWorkers, 5 * 60 * 1000) // every 5 min
    return () => clearInterval(interval)
  }, [])

  // Voice: register/unregister based on voice_enabled setting
  const voiceEnabled = settings?.voice_enabled ?? false
  useEffect(() => {
    // Tell Rust to enable/disable fn key interception and pill visibility
    emit('set-voice-mode', { enabled: voiceEnabled }).catch(() => {})

    if (voiceEnabled) {
      setTtsVolume(settings?.voice_volume ?? 0.5)
      registerVoiceHotkey('fn', (base64) => {
        setVoiceActive(true)
        window.dispatchEvent(new CustomEvent('coagent-ws-send', {
          detail: { type: 'voice_audio', data: base64 }
        }))
      }, () => {})
    } else {
      cancelVoice()
      unregisterVoiceHotkey()
    }
    return () => { unregisterVoiceHotkey() }
  }, [voiceEnabled])

  useEffect(() => {
    if (voiceEnabled) setTtsVolume(settings?.voice_volume ?? 0.5)
  }, [settings?.voice_volume, voiceEnabled])


  function handleApprove(id: string) {
    approve(id)
    setSelectedItemId(null)
  }

  function handleReject(id: string) {
    reject(id)
    setSelectedItemId(null)
  }

  function handleApproveAll() {
    queue.filter(i => i.status === 'pending').forEach(i => approve(i.id))
    setDrawerOpen(false)
  }

  function handleRejectAll() {
    queue.filter(i => i.status === 'pending').forEach(i => reject(i.id))
    setDrawerOpen(false)
  }

  // Show loading screen while waiting for WebSocket to establish AND initial
  // data to arrive (settings + chat history). This prevents the app shell from
  // rendering with empty states, red dots, or missing user names.
  // Also wait for hydration before showing activation gate — relay credentials
  // arrive after connection, so we can't decide "new user vs existing" until then.
  // Show onboarding activation if user hasn't activated yet.
  // At this point hydrated=true, so relay credentials have had time to arrive.
  // If relayCredentials exist, the useEffect above will auto-activate.
  if (wsChecked && hydrated && !activated && !relayCredentials) {
    return (
      <div className={`transition-opacity duration-400 ease-out ${activationFading ? 'opacity-0' : 'opacity-100'}`}>
        <OnboardingActivation
          onActivated={(token) => {
            setActivationFading(true)
            setTimeout(() => {
              setActivated(true)
              activateRelay(token, import.meta.env.VITE_RELAY_URL as string)
            }, 450)
          }}
        />
      </div>
    )
  }

  return (
    <>
      <ConnectingOverlay visible={!wsChecked || !hydrated} />

      {error && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-[12.5px] px-4 py-2.5 rounded-xl shadow-md max-w-sm text-center">
          {error}
        </div>
      )}

      {updater.available && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[12.5px] px-4 py-2.5 rounded-xl shadow-lg flex items-center gap-3">
          {updater.downloading ? (
            <span>Updating... {updater.progress}%</span>
          ) : (
            <>
              <span>v{updater.version} available</span>
              <button onClick={updater.install} className="px-2.5 py-0.5 rounded-md bg-white/20 dark:bg-black/10 hover:bg-white/30 dark:hover:bg-black/20 font-medium transition-colors">Update</button>
              <button onClick={updater.dismiss} className="text-white/50 dark:text-neutral-400 hover:text-white dark:hover:text-neutral-900 transition-colors">&times;</button>
            </>
          )}
        </div>
      )}

      <div className="app-body">
        <Sidebar
          view={view}
          onViewChange={setView}
          queueCount={queue.length}
          integrations={integrations}
          onConnect={connectIntegration}
          onDisconnect={disconnectIntegration}
          onOpenModal={() => setModalOpen(true)}
          userName={settings?.name || undefined}
          dark={dark}
          toggleTheme={toggleTheme}
          hasTeam={!!teamInfo}
          onQueueBadgeClick={() => { if (canvasVisible) closeCanvas(); setDrawerOpen(true); dismissQueueToast() }}
        />

        {view === 'chat' && (
          <div className="relative flex-1 flex overflow-hidden">
            <ChatPane messages={messages} streamingText={streamingText} thinking={thinking} processing={processing} toolLabel={toolLabel} researchAgents={researchAgents} connected={connected} onChat={chat} onSteer={steer} onStop={stopAgent} onIngestFile={ingestFile} files={files} onNavigateToSettings={() => setView('settings')} lastHeartbeat={lastHeartbeat} heartbeatLog={heartbeatLog} onTriggerHeartbeat={triggerHeartbeat} statusLine={statusLine} skills={skills} capabilityCard={capabilityCard} onConfirmCapabilities={confirmCapabilities} userName={settings?.name} userRole={settings?.role} onboarded={settings?.onboarded} agentName={settings?.agent_name} codeCells={codeCells} codeCellOrder={codeCellOrder} onCancelCodeCell={cancelCodeCell} onOpenCanvas={openCanvas} className="flex-1" />
            {newQueueItems.length > 0 && !drawerOpen && (
              <QueueToast
                items={newQueueItems}
                onReview={() => { setDrawerOpen(true); dismissQueueToast() }}
                onDismiss={dismissQueueToast}
              />
            )}
            {canvas && canvasVisible && (
              <CanvasPane
                canvas={canvas}
                streaming={canvasStreaming}
                streamingCode={canvasStreamingCode || undefined}
                settings={settings}
                onClose={closeCanvas}
                onSaveToFiles={ingestFile}
                canvasesList={canvasesList}
                onOpenCanvas={openCanvas}
                onLoadCanvases={getCanvases}

              />
            )}
            <QueueDrawer
              open={drawerOpen}
              queue={queue}
              onClose={() => setDrawerOpen(false)}
              onApprove={handleApprove}
              onReject={handleReject}
              onApproveAll={handleApproveAll}
              onRejectAll={handleRejectAll}
              onEdit={editQueueItem}
            />
          </div>
        )}

        {view === 'calendar' && (
          <CalendarPane
            entries={calendarEntries}
            onComplete={completeCalendarEntry}
            onDelete={deleteCalendarEntry}
            activeHours={settings?.active_hours}
            googleCalendarStatus={googleCalendarStatus}
            onGoogleConnect={googleCalendarConnect}
            onGoogleDisconnect={googleCalendarDisconnect}
            onGoogleToggle={googleCalendarToggle}
            onGoogleColor={googleCalendarColor}
            onGoogleSync={googleCalendarSync}
            autoBriefMeetings={settings?.auto_brief_meetings}
            autoBriefMinutes={settings?.auto_brief_minutes}
            autoRecapMeetings={settings?.auto_recap_meetings}
            autoRecapMinutes={settings?.auto_recap_minutes}
            onUpdateSettings={updateSettings}
          />
        )}

        {view === 'queue' && (
          <>
            <QueuePane queue={queue} done={done} selectedId={selectedItem?.id ?? null} onSelect={setSelectedItem} />
            <DetailPane item={selectedItem} onApprove={handleApprove} onReject={handleReject} onEdit={editQueueItem} />
          </>
        )}

        {view === 'settings' && (
          <SettingsPane
            settings={settings}
            onUpdate={updateSettings}
            relayActive={relayActive}
            relayModel={relayModel}
            onSetRelayModel={setRelayModel}
            relayUsage={relayUsage}
            onActivateRelay={activateRelay}
            onRefreshRelayStatus={refreshRelayStatus}
            onSetModel={setModel}
            usage={usage}
            onRefreshUsage={refreshUsage}
            isAdmin={isAdmin}
            adminUsers={adminUsers}
            adminNewToken={adminNewToken}
            onAdminCreateToken={adminCreateToken}
            onAdminListTokens={adminListTokens}
            onAdminRevokeToken={adminRevokeToken}
            onClearAdminNewToken={clearAdminNewToken}
            referralCode={partnerStats?.referralCode}
            commissionRate={partnerStats?.commissionRate ? partnerStats.commissionRate * 100 : undefined}
            tier={partnerStats?.tier === 'founder' ? 'Founder' : partnerStats?.tier === 'early_access' ? 'Early Access' : partnerStats?.tier === 'standard' ? 'Standard' : undefined}
            stripeConnectId={partnerStats?.stripeConnectId}
            onSetupPayouts={handleSetupPayouts}
          />
        )}

        {view === 'skills' && (
          <SkillsPane
            skills={skills}
            onUpdate={updateSkill}
            onDelete={deleteSkill}
          />
        )}

        {view === 'team' && (
          <TeamPane
            team={teamInfo}
            messages={teamMessages}
            teamStatus={teamStatus}
            onSendMessage={sendTeamMessage}
            relayUrl={relayCredentials?.relayUrl}
            relayToken={relayCredentials?.token}
          />
        )}

        {view === 'files' && (
          <FilesPane
            files={files}
            folders={folders}
            searchResults={searchResults}
            transcribingFiles={transcribingFiles}
            onIngest={ingestFile}
            onIngestPaths={ingestFilePaths}
            onDelete={deleteFile}
            onCreateFolder={createFolder}
            onMoveFile={moveFile}
            onRenameFile={renameFile}
            onRenameFolder={renameFolder}
            onDeleteFolder={deleteFolder}
            onReorderFolders={reorderFolders}
            onMoveFolder={moveFolder}
            onSearchFiles={searchFilesUI}
            organizing={organizing}
            onAutoOrganize={autoOrganize}
            onOpenCanvas={(id) => { openCanvas(id); setView('chat') }}
          />
        )}
      </div>

      <IntegrationsModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        integrations={integrations}
        onConnect={connectIntegration}
        onDisconnect={disconnectIntegration}
        onDelete={deleteCustomIntegration}
        pendingFields={pendingFields}
        onClearPendingFields={() => setPendingFields(null)}
        whatsappQr={whatsappQr}
        relayCredentials={relayCredentials}
        onToggleTrigger={toggleTrigger}
        onChat={chat}
      />

      {/* Onboarding tour — shown on first launch until user finishes the tour walkthrough */}
      {settings && !settings.onboarded && !tourDone && connected && (
        <OnboardingTour
          settings={settings}
          onUpdate={updateSettings}
          onOpenIntegrations={() => setModalOpen(true)}
          onNavigate={(v) => setView(v as View)}
          onActivate={activateRelay}
          onEnableWakeScheduling={enableWakeScheduling}
          hasRelay={!!relayCredentials}
          setTourDone={markTourDone}
        />
      )}

      {/* Trigger prompt — shown after first connection of an integration with triggers */}
      {triggerPrompt && triggerPrompt.triggers && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setTriggerPrompt(null)}>
          <div className="bg-white dark:bg-neutral-900 rounded-xl shadow-xl w-[340px] p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2.5 mb-1">
              <img
                src={`https://logos.composio.dev/api/${triggerPrompt.slug}`}
                alt={triggerPrompt.name}
                className="w-5 h-5 object-contain"
                onError={e => { (e.target as HTMLImageElement).style.opacity = '0' }}
              />
              <span className="text-[14px] font-semibold text-neutral-900 dark:text-neutral-100">
                {triggerPrompt.name} connected
              </span>
            </div>
            <p className="text-[12px] text-neutral-500 dark:text-neutral-400 mb-4">
              Enable notifications so your agent can respond to events automatically.
            </p>
            <div className="flex flex-col gap-2.5 mb-5">
              {triggerPrompt.triggers.map(trigger => (
                <label key={trigger.slug} className="flex items-center gap-2.5 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={trigger.enabled}
                    onChange={e => {
                      toggleTrigger(trigger.slug, triggerPrompt.slug, e.target.checked)
                      setTriggerPrompt(prev => prev ? {
                        ...prev,
                        triggers: prev.triggers?.map(t => t.slug === trigger.slug ? { ...t, enabled: e.target.checked } : t)
                      } : null)
                    }}
                    className="w-3.5 h-3.5 rounded border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 focus:ring-0 focus:ring-offset-0 cursor-pointer"
                  />
                  <span className="text-[13px] text-neutral-700 dark:text-neutral-300 group-hover:text-neutral-900 dark:group-hover:text-neutral-100 transition-colors">
                    {trigger.label}
                  </span>
                </label>
              ))}
            </div>
            <button
              onClick={() => setTriggerPrompt(null)}
              className="w-full py-2 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-[13px] font-medium hover:opacity-90 transition-opacity"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </>
  )
}
