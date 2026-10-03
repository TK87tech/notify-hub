import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { useState } from "react";
import { z } from "zod";

import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/auth/auth-context";

/**
 * Checked here as well as on the server so an obviously malformed address never
 * becomes a request. The server still validates: this is a courtesy, not a gate.
 */
const schema = z.object({
  email: z.string().min(1, "Enter your email address.").email("That is not an email address."),
  password: z.string().min(1, "Enter your password."),
});

type FormValues = z.infer<typeof schema>;

export default function SignInPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);

    try {
      await signIn(values.email, values.password);
      navigate("/", { replace: true });
    } catch (err) {
      // One message for both wrong-email and wrong-password on purpose: telling
      // them apart would confirm which addresses have accounts.
      setFormError(
        err instanceof ApiError && err.status !== 0
          ? err.message
          : "Could not reach the server. Check your connection and try again.",
      );
    }
  });

  const pending = form.formState.isSubmitting;

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign in to NotifyHub</CardTitle>

          <CardDescription>
            Your notification centre. Sign in to see everything that has been sent to you.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={onSubmit} noValidate>
            <FieldGroup>
              {/* role="alert" so the failure is announced, not just painted red:
                  a form that fails silently to a screen reader user is a bug,
                  not a cosmetic issue. */}
              {formError && (
                <FieldError role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
                  {formError}
                </FieldError>
              )}

              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>

                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  aria-invalid={Boolean(form.formState.errors.email)}
                  aria-describedby={form.formState.errors.email ? "email-error" : undefined}
                  {...form.register("email")}
                />

                {form.formState.errors.email && (
                  <FieldError id="email-error">{form.formState.errors.email.message}</FieldError>
                )}
              </Field>

              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>

                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={Boolean(form.formState.errors.password)}
                  aria-describedby={form.formState.errors.password ? "password-error" : undefined}
                  {...form.register("password")}
                />

                {form.formState.errors.password && (
                  <FieldError id="password-error">{form.formState.errors.password.message}</FieldError>
                )}
              </Field>

              <Field>
                <Button type="submit" className="w-full" disabled={pending}>
                  {pending ? "Signing in…" : "Sign in"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>

        <CardFooter>
          <FieldDescription className="text-xs">
            NotifyHub sends email, push and in-app notifications through a queue. Sign-in only
            controls what this browser can see.
          </FieldDescription>
        </CardFooter>
      </Card>
    </main>
  );
}