import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { BaseStyles, Button, TextInput, ThemeProvider } from '@primer/react'
import '@primer/primitives/dist/css/functional/themes/light.css'
import '@primer/primitives/dist/css/functional/themes/dark.css'
import App from '../ui/App'
import '../ui/index.css'
import './web.css'
import { createWebApi } from './api'

const api = createWebApi()
window.api = api

function Root(): React.JSX.Element {
  const [state, setState] = useState<'loading' | 'setup' | 'login' | 'ready'>('loading')
  const [canChangePassword, setCanChangePassword] = useState(false)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const applyAuthStatus = (status: {
    state: 'setup' | 'login' | 'open'
    authenticated: boolean
    canChangePassword: boolean
  }): void => {
    setCanChangePassword(status.canChangePassword)
    if (status.state === 'setup') {
      setState('setup')
      return
    }
    if (status.state === 'login' && !status.authenticated) {
      setState('login')
      return
    }
    setState('ready')
  }

  useEffect(() => {
    api
      .authStatus()
      .then(applyAuthStatus)
      .catch(() => setState('ready'))
  }, [])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await api.login(username, password)
      applyAuthStatus(await api.authStatus())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setSubmitting(false)
    }
  }

  const submitSetup = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    const trimmedUsername = username.trim()
    if (trimmedUsername.length < 1 || trimmedUsername.length > 64) {
      setError('Username must be 1 to 64 characters.')
      return
    }
    if (password.length < 8 || password.length > 256) {
      setError('Password must be 8 to 256 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await api.setup({ username: trimmedUsername, password })
      setPassword('')
      setConfirmPassword('')
      applyAuthStatus(await api.authStatus())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed')
    } finally {
      setSubmitting(false)
    }
  }

  const enableOpenMode = async (): Promise<void> => {
    if (!window.confirm('Run without a password? Anyone who can reach this app can use it.')) return
    setSubmitting(true)
    setError(null)
    try {
      await api.setup({ mode: 'open' })
      applyAuthStatus(await api.authStatus())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (state === 'loading') {
    return (
      <div className="login">
        <p>Loading…</p>
      </div>
    )
  }

  if (state === 'login') {
    return (
      <div className="login">
        <form className="login__card" onSubmit={submit}>
          <h1>Siphon</h1>
          <p>Enter your username and password to continue.</p>
          <TextInput
            type="text"
            block
            aria-label="Username"
            autoComplete="username"
            autoFocus
            value={username}
            placeholder="Username"
            onChange={(e) => setUsername(e.target.value)}
          />
          <TextInput
            type="password"
            block
            aria-label="Password"
            value={password}
            placeholder="Password"
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="login__error">{error}</p>}
          <Button type="submit" variant="primary" block disabled={submitting || !password}>
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    )
  }

  if (state === 'setup') {
    return (
      <div className="login">
        <form className="login__card login__card--setup" onSubmit={submitSetup}>
          <h1>Siphon setup</h1>
          <p>Create an admin account for first run.</p>
          <TextInput
            type="text"
            block
            aria-label="Setup username"
            autoComplete="username"
            autoFocus
            value={username}
            placeholder="Admin username"
            onChange={(e) => setUsername(e.target.value)}
          />
          <TextInput
            type="password"
            block
            aria-label="Setup password"
            autoComplete="new-password"
            value={password}
            placeholder="Password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <TextInput
            type="password"
            block
            aria-label="Confirm setup password"
            autoComplete="new-password"
            value={confirmPassword}
            placeholder="Confirm password"
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          <p className="login__warning">
            Finish setup before exposing Siphon to untrusted networks.
          </p>
          {error && <p className="login__error">{error}</p>}
          <Button type="submit" variant="primary" block disabled={submitting}>
            {submitting ? 'Saving…' : 'Create admin account'}
          </Button>
          <Button type="button" variant="default" block disabled={submitting} onClick={enableOpenMode}>
            Run without a password
          </Button>
        </form>
      </div>
    )
  }

  return <App canChangePassword={canChangePassword} />
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider colorMode="auto">
      <BaseStyles>
        <Root />
      </BaseStyles>
    </ThemeProvider>
  </React.StrictMode>
)
