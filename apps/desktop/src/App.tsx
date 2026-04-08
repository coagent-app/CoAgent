import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
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
import { CanvasReopenChip } from '@/components/CanvasReopenChip'
import { CanvasExportSurface } from '@/components/CanvasExportSurface'
import { OnboardingTour } from '@/components/OnboardingTour'
import { useAgent } from '@/hooks/useAgent'
import { useUpdater } from '@/hooks/useUpdater'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { registerVoiceHotkey, unregisterVoiceHotkey, cancelVoice, setTtsVolume } from '@/lib/voice'
import { emit } from '@tauri-apps/api/event'
import type { ApprovalItem } from '@coagent/shared'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { FileText, X } from 'lucide-react'

// ── PDF export toast ───────────────────────────────────────────────────────
// Shown briefly after a user-initiated Canvas PDF export finishes, so they
// have visible feedback and a fast way to access the file.
function ExportToast({ filename, filePath, onShowInFiles, onDismiss }: { filename: string; filePath?: string; onShowInFiles: () => void; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 8000)
    return () => clearTimeout(t)
  }, [onDismiss])
  const revealInFinder = () => {
    if (!filePath) return
    tauriInvoke('reveal_in_file_manager', { path: filePath }).catch(err => console.error('[Toast] Reveal failed:', err))
    onDismiss()
  }
  return (
    <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-xl shadow-lg px-4 py-3 max-w-sm animate-in fade-in slide-in-from-bottom-2 duration-200">
      <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 flex items-center justify-center">
        <FileText size={16} className="text-emerald-600 dark:text-emerald-400" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[12.5px] font-medium text-neutral-800 dark:text-neutral-200">PDF saved to Files</p>
        <p className="text-[11px] text-neutral-400 dark:text-neutral-500 truncate">{filename}</p>
      </div>
      {filePath && (
        <button
          onClick={revealInFinder}
          className="text-[11.5px] font-medium text-neutral-700 dark:text-neutral-200 hover:text-neutral-900 dark:hover:text-white px-2 py-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
        >
          Reveal
        </button>
      )}
      <button
        onClick={onShowInFiles}
        className="text-[11.5px] font-medium text-neutral-700 dark:text-neutral-200 hover:text-neutral-900 dark:hover:text-white px-2 py-1 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
      >
        Show
      </button>
      <button
        onClick={onDismiss}
        className="flex-shrink-0 p-1 rounded-md text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  )
}
export default function App() {
  const { queue, done, messages, streamingText, thinking, processing, toolLabel, researchAgents, connected, lastHeartbeat, heartbeatLog, triggerHeartbeat, statusLine, skills, updateSkill, deleteSkill, steer, stopAgent, integrations, error, chat, approve, reject, editQueueItem, connectIntegration, disconnectIntegration, settings, updateSettings, authStatus, updateAuth, verifyAuth, files, folders, searchResults, ingestFile, deleteFile, ingestFilePaths, createFolder, moveFile, renameFile, renameFolder, deleteFolder, reorderFolders, moveFolder, searchFilesUI, relayActive, relayModel, setRelayModel, relayUsage, activateRelay, refreshRelayStatus, pendingFields, setPendingFields, setModel, usage, refreshUsage, organizing, autoOrganize, calendarEntries, completeCalendarEntry, deleteCalendarEntry, googleCalendarStatus, googleCalendarConnect, googleCalendarDisconnect, googleCalendarToggle, googleCalendarColor, googleCalendarSync, capabilityCard, confirmCapabilities, deleteCustomIntegration, whatsappQr, toggleTrigger, getRelayCredentials, relayCredentials, isAdmin, adminUsers, adminNewToken, clearAdminNewToken, adminCreateToken, adminListTokens, adminRevokeToken, teamInfo, teamMessages, teamStatus, sendTeamMessage, triggerPrompt, setTriggerPrompt, canvasDoc, canvasStreaming, canvasExporting, canvasVisible, openCanvasDoc, closeCanvas, reopenCanvas, exportCanvasPdf, pendingExport, completePendingExport, failPendingExport, exportToast, dismissExportToast } = useAgent()
  const { dark, toggle: toggleTheme } = useTheme()
  const updater = useUpdater()
  const [view, setView] = useState<View>('chat')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const selectedItem = selectedItemId ? queue.find(i => i.id === selectedItemId) ?? null : null
  const setSelectedItem = useCallback((item: ApprovalItem | null) => setSelectedItemId(item?.id ?? null), [])
  const [modalOpen, setModalOpen] = useState(false)
  const [tourDone, setTourDone] = useState(() => localStorage.getItem('tourDone') === '1')
  const markTourDone = useCallback((done: boolean) => { setTourDone(done); if (done) localStorage.setItem('tourDone', '1') }, [])

  // ESC to cancel voice/stop agent — always fire both regardless of state
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (canvasVisible) { closeCanvas(); return }
        cancelVoice()
        stopAgent()
      }
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [stopAgent, canvasVisible, closeCanvas])

  // Voice: register/unregister based on voice_enabled setting
  const voiceEnabled = settings?.voice_enabled ?? false
  useEffect(() => {
    // Tell Rust to enable/disable fn key interception and pill visibility
    emit('set-voice-mode', { enabled: voiceEnabled }).catch(() => {})

    if (voiceEnabled) {
      setTtsVolume(settings?.voice_volume ?? 0.5)
      registerVoiceHotkey('fn', (base64) => {
        ;(window as any).__voiceActive = true
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


  function handleApprove(id: string) {
    approve(id)
    setSelectedItemId(null)
  }

  function handleReject(id: string) {
    reject(id)
    setSelectedItemId(null)
  }

  return (
    <>
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
        />

        {view === 'chat' && (
          <div className="relative flex-1 flex overflow-hidden">
            <ChatPane messages={messages} streamingText={streamingText} thinking={thinking} processing={processing} toolLabel={toolLabel} researchAgents={researchAgents} connected={connected} onChat={chat} onSteer={steer} onStop={stopAgent} onIngestFile={ingestFile} files={files} onNavigateToSettings={() => setView('settings')} lastHeartbeat={lastHeartbeat} heartbeatLog={heartbeatLog} onTriggerHeartbeat={triggerHeartbeat} statusLine={statusLine} skills={skills} capabilityCard={capabilityCard} onConfirmCapabilities={confirmCapabilities} userName={settings?.name} userRole={settings?.role} onboarded={settings?.onboarded} agentName={settings?.agent_name} onOpenCanvasDoc={openCanvasDoc} className="flex-1" />
            {canvasDoc && canvasVisible && (
              <CanvasPane
                doc={canvasDoc}
                streaming={canvasStreaming}
                brand={settings ? {
                  companyName: settings.brand_company || undefined,
                  primary: settings.brand_primary || undefined,
                  secondary: settings.brand_secondary || undefined,
                  tertiary: settings.brand_tertiary || undefined,
                  logoDataUri: settings.brand_logo || undefined,
                } : undefined}
                onClose={closeCanvas}
                onExportPdf={exportCanvasPdf}
                exporting={canvasExporting}
              />
            )}
            {canvasDoc && !canvasVisible && (
              <CanvasReopenChip
                title={canvasDoc.title}
                streaming={canvasStreaming}
                onReopen={reopenCanvas}
              />
            )}
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
            onOpenCanvasDoc={(docId) => { openCanvasDoc(docId); setView('chat') }}
          />
        )}
      </div>


      {exportToast && (
        <ExportToast
          filename={exportToast.filename}
          filePath={files.find(f => f.id === exportToast.fileId)?.path}
          onShowInFiles={() => {
            setView('files')
            dismissExportToast()
          }}
          onDismiss={dismissExportToast}
        />
      )}

      {/* Off-screen PDF rendering surface for agent-initiated export_document_pdf.
          Mounted only while a pendingExport exists; it renders, reports the
          base64 back, and clears itself. */}
      {pendingExport && (
        <CanvasExportSurface
          key={pendingExport.requestId}
          doc={pendingExport.doc}
          brand={settings ? {
            companyName: settings.brand_company || undefined,
            primary: settings.brand_primary || undefined,
            secondary: settings.brand_secondary || undefined,
            tertiary: settings.brand_tertiary || undefined,
            logoDataUri: settings.brand_logo || undefined,
          } : undefined}
          onRendered={(r) => completePendingExport(r.base64)}
          onError={(msg) => failPendingExport(msg)}
        />
      )}

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
