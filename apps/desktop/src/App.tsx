import React, { useState, useRef, useEffect } from 'react'
import { CheckCircle2, Circle, Trash2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Sidebar } from '@/components/Sidebar'
import type { View } from '@/components/Sidebar'
import { QueuePane } from '@/components/QueuePane'
import { DetailPane } from '@/components/DetailPane'
import { ChatPane } from '@/components/ChatPane'
import { IntegrationsModal } from '@/components/IntegrationsModal'
import { SettingsPane } from '@/components/SettingsPane'
import { FilesPane } from '@/components/FilesPane'
import { DocumentPanel } from '@/components/DocumentPanel'
import { useAgent } from '@/hooks/useAgent'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import type { ApprovalItem } from '@coagent/shared'

function formatDue(due: string): string {
  const hasTime = due.includes('T')
  const date = new Date(hasTime ? due : due + 'T00:00:00')
  if (hasTime) {
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function App() {
  const { queue, done, todos, messages, streamingText, thinking, processing, toolLabel, connected, lastHeartbeat, skills, steer, stopAgent, integrations, error, chat, approve, reject, editQueueItem, completeTodo, deleteTodo, connectIntegration, disconnectIntegration, settings, updateSettings, authStatus, updateAuth, verifyAuth, files, folders, searchResults, ingestFile, deleteFile, ingestFilePaths, createFolder, moveFile, renameFile, renameFolder, deleteFolder, reorderFolders, moveFolder, searchFilesUI, openDocument, activeDocument, updateDocument, closeDocument, relayActive, relayModel, setRelayModel, relayUsage, activateRelay, refreshRelayStatus, apiKeyStatus, pendingFields, setPendingFields, updateApiKeys, setModel } = useAgent()
  const { dark, toggle: toggleTheme } = useTheme()
  const [view, setView] = useState<View>('chat')
  const [selectedItem, setSelectedItem] = useState<ApprovalItem | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [lastDocumentId, setLastDocumentId] = useState<string | null>(null)

  useEffect(() => {
    if (activeDocument) setLastDocumentId(activeDocument.id)
  }, [activeDocument])

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
          todoCount={todos.length}
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
            <ChatPane messages={messages} streamingText={streamingText} thinking={thinking} processing={processing} toolLabel={toolLabel} connected={connected} onChat={chat} onSteer={steer} onStop={stopAgent} onIngestFile={ingestFile} files={files} onOpenDocument={openDocument} activeDocumentId={lastDocumentId} apiKeyStatus={apiKeyStatus} onNavigateToSettings={() => setView('settings')} lastHeartbeat={lastHeartbeat} skills={skills} className="flex-1" />
            {activeDocument && (
              <DocumentPanel
                document={activeDocument}
                onUpdate={updateDocument}
                onClose={closeDocument}
              />
            )}
          </div>
        )}

        {view === 'queue' && (
          <>
            <QueuePane queue={queue} done={done} selectedId={selectedItem?.id ?? null} onSelect={setSelectedItem} />
            <DetailPane item={selectedItem} onApprove={handleApprove} onReject={handleReject} onEdit={editQueueItem} />
          </>
        )}

        {view === 'todos' && (
          <ScrollArea className="flex-1 bg-white dark:bg-neutral-950">
            <div className="px-8 py-7">
              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">Tasks</p>
              <h1 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100 mb-6">To-Do</h1>
              {todos.length === 0 ? (
                <p className="text-[14px] text-neutral-400 dark:text-neutral-500">No tasks yet. Ask Co-Agent to add one.</p>
              ) : (
                <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
                  {todos.map(item => (
                    <div key={item.id} className="flex items-start gap-3 py-3 group">
                      <button onClick={() => completeTodo(item.id)} className="mt-0.5 flex-shrink-0 text-neutral-300 dark:text-neutral-600 hover:text-emerald-500 transition-colors">
                        <Circle size={15} strokeWidth={1.75} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] text-neutral-800 dark:text-neutral-200 leading-relaxed">{item.task}</p>
                        {item.due && (
                          <p className={cn('text-[12px] mt-0.5', new Date(item.due.includes('T') ? item.due : item.due + 'T23:59:59') < new Date() ? 'text-red-500' : 'text-neutral-400 dark:text-neutral-500')}>
                            {formatDue(item.due)}
                          </p>
                        )}
                      </div>
                      <button onClick={() => deleteTodo(item.id)} className="opacity-0 group-hover:opacity-100 transition-opacity text-neutral-300 dark:text-neutral-600 hover:text-red-500 flex-shrink-0 mt-0.5">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
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
            apiKeyStatus={apiKeyStatus}
            onUpdateApiKeys={updateApiKeys}
            onSetModel={setModel}
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
          />
        )}

        {view === 'done' && (
          <ScrollArea className="flex-1 bg-white dark:bg-neutral-950">
            <div className="px-8 py-7">
              <p className="text-[10px] font-semibold text-neutral-400 dark:text-neutral-500 uppercase tracking-widest mb-1">Completed</p>
              <h1 className="text-[19px] font-bold tracking-tight text-neutral-900 dark:text-neutral-100 mb-6">Activity log</h1>
              {done.length === 0 ? (
                <p className="text-[14px] text-neutral-400 dark:text-neutral-500">Nothing completed yet.</p>
              ) : (
                <div className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-800">
                  {done.map(item => (
                    <div key={item.id} className="flex items-start gap-3 py-3">
                      <CheckCircle2 size={15} strokeWidth={1.75} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                      <span className="text-[14px] text-neutral-600 dark:text-neutral-400 leading-relaxed">{item.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </ScrollArea>
        )}
      </div>

      <IntegrationsModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        integrations={integrations}
        onConnect={connectIntegration}
        onDisconnect={disconnectIntegration}
        pendingFields={pendingFields}
        onClearPendingFields={() => setPendingFields(null)}
      />
    </>
  )
}
