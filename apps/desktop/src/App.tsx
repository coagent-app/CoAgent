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
import { useAgent } from '@/hooks/useAgent'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { registerVoiceHotkey, unregisterVoiceHotkey, cancelVoice } from '@/lib/voice'
import { emit } from '@tauri-apps/api/event'
import type { ApprovalItem } from '@coagent/shared'

export default function App() {
  const { queue, done, messages, streamingText, thinking, processing, toolLabel, researchAgents, connected, lastHeartbeat, skills, updateSkill, deleteSkill, steer, stopAgent, integrations, error, chat, approve, reject, editQueueItem, connectIntegration, disconnectIntegration, settings, updateSettings, authStatus, updateAuth, verifyAuth, files, folders, searchResults, ingestFile, deleteFile, ingestFilePaths, createFolder, moveFile, renameFile, renameFolder, deleteFolder, reorderFolders, moveFolder, searchFilesUI, relayActive, relayModel, setRelayModel, relayUsage, activateRelay, refreshRelayStatus, pendingFields, setPendingFields, setModel, usage, refreshUsage, organizing, autoOrganize, calendarEntries, completeCalendarEntry, deleteCalendarEntry, googleCalendarStatus, googleCalendarConnect, googleCalendarDisconnect, googleCalendarToggle, googleCalendarColor, googleCalendarSync, capabilityCard, confirmCapabilities, deleteCustomIntegration, whatsappQr, toggleTrigger, getRelayCredentials, relayCredentials, isAdmin, adminUsers, adminNewToken, clearAdminNewToken, adminCreateToken, adminListTokens, adminRevokeToken, teamInfo, teamMessages, teamStatus, sendTeamMessage, triggerPrompt, setTriggerPrompt } = useAgent()
  const { dark, toggle: toggleTheme } = useTheme()
  const [view, setView] = useState<View>('chat')
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null)
  const selectedItem = selectedItemId ? queue.find(i => i.id === selectedItemId) ?? null : null
  const setSelectedItem = useCallback((item: ApprovalItem | null) => setSelectedItemId(item?.id ?? null), [])
  const [modalOpen, setModalOpen] = useState(false)

  // Voice: register/unregister based on voice_enabled setting
  const voiceEnabled = settings?.voice_enabled ?? false
  useEffect(() => {
    // Tell Rust to enable/disable fn key interception and pill visibility
    emit('set-voice-mode', { enabled: voiceEnabled }).catch(() => {})

    if (voiceEnabled) {
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
            <ChatPane messages={messages} streamingText={streamingText} thinking={thinking} processing={processing} toolLabel={toolLabel} researchAgents={researchAgents} connected={connected} onChat={chat} onSteer={steer} onStop={stopAgent} onIngestFile={ingestFile} files={files} onNavigateToSettings={() => setView('settings')} lastHeartbeat={lastHeartbeat} skills={skills} capabilityCard={capabilityCard} onConfirmCapabilities={confirmCapabilities} userName={settings?.name} userRole={settings?.role} onboarded={settings?.onboarded} className="flex-1" />
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
