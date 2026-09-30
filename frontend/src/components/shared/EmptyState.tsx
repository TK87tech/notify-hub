import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface EmptyStateProps {
  title: string;
  description?: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <Alert>
      <AlertTitle>{title}</AlertTitle>

      {description && <AlertDescription>{description}</AlertDescription>}
    </Alert>
  );
}
