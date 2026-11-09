import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { reportPrivateRuntimeError } from "@/lib/error-report";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Errors go to the browser console only.
    reportPrivateRuntimeError("[App Error]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center p-8">
          <div className="max-w-lg rounded-lg border border-destructive/20 bg-destructive/10 p-6">
            <h2 className="mb-2 text-lg font-semibold text-destructive">
              Something went wrong
            </h2>
            <p className="font-mono text-sm text-destructive/80">
              {this.state.error?.message}
            </p>
            <Button
              variant="destructive"
              className="mt-4"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try Again
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
