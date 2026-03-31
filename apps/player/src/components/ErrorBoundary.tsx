'use client';

import React from 'react';
import { Button, Card } from '@badminton/ui';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-4">
          <Card className="max-w-md w-full text-center">
            <div className="w-16 h-16 rounded-full bg-[var(--color-danger)]/10 flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">!</span>
            </div>
            <h2 className="text-xl font-bold text-[var(--text-primary)] mb-2">Something went wrong</h2>
            <p className="text-[var(--text-muted)] text-sm mb-6">
              An unexpected error occurred. Please try again.
            </p>
            <Button
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.reload();
              }}
              className="w-full"
            >
              Retry
            </Button>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
