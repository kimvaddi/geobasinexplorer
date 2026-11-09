/* Errors go to the browser console only. The app sends nothing anywhere. */
export function reportPrivateRuntimeError(label: string, error?: unknown, componentStack?: string | null): void {
  console.error(label, error, componentStack ?? "");
}
