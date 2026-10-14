import { Dialog } from '@primer/react'
import type { CollisionChoice } from '../hooks/useDownloadCollisions'

export function DownloadCollisionDialog({ choice }: { choice: CollisionChoice | null }) {
  if (!choice) return null
  const { conflict, batch, choose } = choice
  return (
    <Dialog
      key={conflict.entryId}
      title="Download destination exists"
      onClose={() => choose('cancel')}
      footerButtons={[
        {
          content: batch ? 'Cancel batch' : 'Cancel',
          onClick: () => choose('cancel'),
          autoFocus: true
        },
        ...(batch ? [{ content: 'Skip this file', onClick: () => choose('skip') }] : []),
        ...(conflict.canOverwrite
          ? [
              {
                content: 'Overwrite',
                buttonType: 'danger' as const,
                onClick: () => choose('overwrite')
              }
            ]
          : [])
      ]}
    >
      <p>{conflict.remotePath}</p>
      <p>
        <strong>Destination:</strong> {conflict.localPath}
      </p>
      <p>
        {conflict.canOverwrite
          ? 'Overwrite downloads a fresh copy and preserves the previous file in a recovery location shown in Transfers.'
          : 'A directory, symlink, or file blocking a required folder cannot be overwritten.'}
      </p>
      {batch && (
        <p>
          No files in this batch start until all collisions are decided. Collision{' '}
          {choice.index + 1} of {choice.count}.
        </p>
      )}
    </Dialog>
  )
}
