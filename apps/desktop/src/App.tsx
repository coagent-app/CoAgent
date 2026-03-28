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
import { useAgent } from '@/hooks/useAgent'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import { registerVoiceHotkey, unregisterVoiceHotkey, cancelVoice } from '@/lib/voice'
import { emit } from '@tauri-apps/api/event'
import type { ApprovalItem } from '@coagent/shared'

export default function App() {
  const { queue, done, messages, streamingText, thinking, processing, toolLabel, connected, lastHeartbeat, skills, updateSkill, deleteSkill, steer, stopAgent, integrations, error, chat, approve, reject, editQueueItem, connectIntegration, disconnectIntegration, settings, updateSettings, authStatus, updateAuth, verifyAuth, files, folders, searchResults, ingestFile, deleteFile, ingestFilePaths, createFolder, moveFile, renameFile, renameFolder, deleteFolder, reorderFolders, moveFolder, searchFilesUI, relayActive, relayModel, setRelayModel, relayUsage, activateRelay, refreshRelayStatus, pendingFields, setPendingFields, setModel, usage, refreshUsage, organizing, autoOrganize, calendarEntries, completeCalendarEntry, deleteCalendarEntry, capabilityCard, confirmCapabilities, deleteCustomIntegration, whatsappQr, toggleTrigger } = useAgent()
  const { dark, toggle: toggleTheme } = useTheme()
  const [view, setView] = useState<View>('chat')
  const [selectedItem, setSelectedItem] = useState<ApprovalItem | null>(null)
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
    setSelectedItem(null)
  }

  function handleReject(id: string) {
    reject(id)
    setSelectedItem(null)
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
        />

        {view === 'chat' && (
          <div className="relative flex-1 flex overflow-hidden">
            <ChatPane messages={messages} streamingText={streamingText} thinking={thinking} processing={processing} toolLabel={toolLabel} connected={connected} onChat={chat} onSteer={steer} onStop={stopAgent} onIngestFile={ingestFile} files={files} onNavigateToSettings={() => setView('settings')} lastHeartbeat={lastHeartbeat} skills={skills} capabilityCard={capabilityCard} onConfirmCapabilities={confirmCapabilities} className="flex-1" />
          </div>
        )}

        {view === 'calendar' && (
          <CalendarPane
            entries={calendarEntries}
            onComplete={completeCalendarEntry}
            onDelete={deleteCalendarEntry}
            activeHours={settings?.active_hours}
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
          />
        )}

        {view === 'skills' && (
          <SkillsPane
            skills={skills}
            onUpdate={updateSkill}
            onDelete={deleteSkill}
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
        onToggleTrigger={toggleTrigger}
      />
    </>
  )
}
