// sam-ui (Apache-2.0). New file, not from SAM 2.
import {createEnvironment} from '@/graphql/RelayEnvironment';
import {Component, Suspense, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {RelayEnvironmentProvider} from 'react-relay';
import App from './App';
import {API_ENDPOINT} from './config';
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
            <h1>Cannot reach the backend</h1>
            <p>
              {API_ENDPOINT} did not answer: {this.state.error.message}
            </p>
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

createRoot(document.getElementById('root')!).render(
  <RelayEnvironmentProvider environment={environment}>
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="app empty-app">
            <span className="loading">
              <span className="spinner" /> Loading…
            </span>
          </div>
        }>
        <App />
      </Suspense>
    </ErrorBoundary>
  </RelayEnvironmentProvider>,
);
