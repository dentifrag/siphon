import { useCallback, useState } from 'react'
import { Button, Dialog, FormControl, TextInput } from '@primer/react'
import { errorMessage } from '../lib/format'

interface PasswordDialogProps {
  canChangePassword: boolean
}

export function PasswordDialog({ canChangePassword }: PasswordDialogProps) {
  const [open, setOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    setCurrentPassword('')
    setNewPassword('')
    setConfirmNewPassword('')
    setError(null)
    setSubmitting(false)
  }, [])

  const submit = useCallback(async () => {
    if (newPassword.length < 8 || newPassword.length > 256) {
      setError('New password must be 8 to 256 characters.')
      return
    }
    if (newPassword !== confirmNewPassword) {
      setError('New passwords do not match.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await window.api.changePassword(currentPassword, newPassword)
      close()
      setNotice('Password updated.')
      window.setTimeout(() => setNotice(null), 3_000)
    } catch (err) {
      setError(errorMessage(err))
      setSubmitting(false)
    }
  }, [close, confirmNewPassword, currentPassword, newPassword])

  return (
    <>
      {notice && <span className="app__notice">{notice}</span>}
      {canChangePassword && (
        <Button size="small" variant="default" onClick={() => setOpen(true)}>
          Change password
        </Button>
      )}
      {open && (
        <Dialog
          title="Change password"
          onClose={close}
          footerButtons={[
            { content: 'Cancel', disabled: submitting, onClick: close },
            {
              content: submitting ? 'Saving…' : 'Update password',
              buttonType: 'primary',
              disabled: submitting,
              onClick: () => void submit()
            }
          ]}
        >
          <div className="password-dialog">
            <FormControl>
              <FormControl.Label>Current password</FormControl.Label>
              <TextInput
                block
                type="password"
                aria-label="Current password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormControl.Label>New password</FormControl.Label>
              <TextInput
                block
                type="password"
                aria-label="New password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </FormControl>
            <FormControl>
              <FormControl.Label>Confirm new password</FormControl.Label>
              <TextInput
                block
                type="password"
                aria-label="Confirm new password"
                autoComplete="new-password"
                value={confirmNewPassword}
                onChange={(e) => setConfirmNewPassword(e.target.value)}
              />
            </FormControl>
            {error && <p className="banner banner--error">{error}</p>}
          </div>
        </Dialog>
      )}
    </>
  )
}
