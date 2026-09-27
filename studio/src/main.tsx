// sam-ui (Apache-2.0). New file, not from SAM 2.
import {createEnvironment} from '@/graphql/RelayEnvironment';
import {Component, Suspense, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {RelayEnvironmentProvider} from 'react-relay';
import {LocalApp, ServerApp} from './App';
import {API_ENDPOINT} from './config';
import {detectBackend} from './lib/mode';
import './styles.css';

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
root.render(fallback);

// with a backend, studio is its UI; without one (the browser-only build, or
// a backend that does not answer), studio runs in the browser alone
void detectBackend().then(backend =>
  root.render(
    <RelayEnvironmentProvider environment={environment}>
      <ErrorBoundary>
        <Suspense fallback={fallback}>{backend ? <ServerApp /> : <LocalApp />}</Suspense>
      </ErrorBoundary>
    </RelayEnvironmentProvider>,
  ),
);
