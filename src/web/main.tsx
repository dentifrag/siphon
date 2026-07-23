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
  const [state, setState] = useState<'loading' | 'login' | 'ready'>('loading')
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    api
      .authStatus()
      .then((status) => setState(status.required && !status.authenticated ? 'login' : 'ready'))
      .catch(() => setState('ready'))
  }, [])

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await api.login(username, password)
      const status = await api.authStatus()
      if (status.authenticated || !status.required) setState('ready')
      else setError('Invalid password')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
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

  return <App />
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
