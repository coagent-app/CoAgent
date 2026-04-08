import type { DocumentBlock } from '@coagent/shared'
import { BlockRenderer } from '@/components/blocks/BlockRenderer'
import { HeaderEditor } from './HeaderEditor'
import { TextEditor } from './TextEditor'
import { FooterEditor } from './FooterEditor'
import { SignoffEditor } from './SignoffEditor'
import { CalloutEditor } from './CalloutEditor'
import { KpisEditor } from './KpisEditor'
import { TableEditor } from './TableEditor'
import { ImageEditor } from './ImageEditor'

export function BlockEditor({ block, isEditing, onCommit }: {
  block: DocumentBlock
  isEditing: boolean
  onCommit: (next: DocumentBlock) => void
}) {
  if (!isEditing) return <BlockRenderer block={block} />
  switch (block.type) {
    case 'header': return <HeaderEditor block={block} onCommit={onCommit as any} />
    case 'text': return <TextEditor block={block} onCommit={onCommit as any} />
    case 'footer': return <FooterEditor block={block} onCommit={onCommit as any} />
    case 'signoff': return <SignoffEditor block={block} onCommit={onCommit as any} />
    case 'callout': return <CalloutEditor block={block} onCommit={onCommit as any} />
    case 'kpis': return <KpisEditor block={block} onCommit={onCommit as any} />
    case 'table': return <TableEditor block={block} onCommit={onCommit as any} />
    case 'image': return <ImageEditor block={block} onCommit={onCommit as any} />
    default: return <BlockRenderer block={block} />
  }
}
