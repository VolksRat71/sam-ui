// sam-ui (Apache-2.0). New file, not from SAM 2.
import {createEnvironment} from '@/graphql/RelayEnvironment';
import {Component, Suspense, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {RelayEnvironmentProvider} from 'react-relay';
import {LocalApp, ServerApp} from './App';
import {API_ENDPOINT, NO_BACKEND_BUILD} from './config';
import {waitForBackend} from './lib/mode';
import './styles.css';
import './responsive.css';

// Meta's Relay environment, pointed at the configured backend
const environment = createEnvironment(API_ENDPOINT);

class ErrorBoundary extends Component<{children: ReactNode}, {error: Error | null}> {
  state = {error: null as Error | null};

  static getDerivedStateFromError(error: Error) {
    return {error};
  }

  render() {
    if (this.state.error != null) {
      return (
        <div className="app empty-app">
          <div className="empty-card">
            <h1>studio stopped</h1>
            <p>{this.state.error.message}</p>
            <p className="muted">Backend: {API_ENDPOINT || 'none (studio runs in this browser)'}</p>
            <button className="button primary" onClick={() => window.location.reload()}>
              Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = createRoot(document.getElementById('root')!);
const fallback = (
  <div className="app empty-app">
    <span className="loading">
      <span className="spinner" /> Loading…
    </span>
  </div>
);

function mount(backend: boolean) {
  root.render(
    <RelayEnvironmentProvider environment={environment}>
      <ErrorBoundary>
        <Suspense fallback={fallback}>{backend ? <ServerApp /> : <LocalApp />}</Suspense>
      </ErrorBoundary>
    </RelayEnvironmentProvider>,
  );
}

// the browser-only build runs in the browser alone; every other build is its
// backend's UI, so it waits for the backend (the desktop app's first answer
// can take seconds) and says so if it never comes, rather than quietly
// becoming the browser demo
function connect() {
  root.render(
    <div className="app empty-app">
      <span className="loading">
        <span className="spinner" /> Connecting to the backend…
      </span>
    </div>,
  );
  waitForBackend().then(
    () => mount(true),
    (err: Error) =>
      root.render(
        <div className="app empty-app">
          <div className="empty-card">
            <h1>Can't reach the backend</h1>
            <p>{err.message}.</p>
            <p className="muted">
              Start it (see the README), then retry. The browser-only version is a separate build:{' '}
              <code>VITE_API_ENDPOINT=none</code>.
            </p>
            <button className="button primary" onClick={connect}>
              Retry
            </button>
          </div>
        </div>,
      ),
  );
}

if (NO_BACKEND_BUILD) {
  mount(false);
} else {
  connect();
}
