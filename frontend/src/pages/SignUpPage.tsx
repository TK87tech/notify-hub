import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/auth/auth-context";

/**
 * Mirrors the server's rules so a bad form never becomes a request. The server
 * still validates - this is a courtesy, not a gate.
 */
const schema = z
  .object({
    name: z.string().trim().max(100, "Keep your name under 100 characters."),
    email: z.string().min(1, "Enter your email address.").email("That is not an email address."),
    password: z.string().min(8, "Use at least 8 characters.").max(200, "Use at most 200 characters."),
    confirm: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    path: ["confirm"],
    message: "The passwords do not match.",
  });

type FormValues = z.infer<typeof schema>;

export default function SignUpPage() {
  const { signUp } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", email: "", password: "", confirm: "" },
  });

  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(async ({ name, email, password }) => {
    setFormError(null);

    try {
      await signUp({ email, password, ...(name ? { name } : {}) });
      navigate("/", { replace: true });
    } catch (err) {
      setFormError(
        err instanceof ApiError && err.status !== 0
          ? err.message
          : "Could not reach the server. Check your connection and try again.",
      );
    }
  });

  const pending = form.formState.isSubmitting;

  const field = (
    name: keyof FormValues,
    label: string,
    props: React.ComponentProps<typeof Input>,
    hint?: string,
  ) => (
    <Field>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>

      <Input
        id={name}
        aria-invalid={Boolean(errors[name])}
        aria-describedby={errors[name] ? `${name}-error` : hint ? `${name}-hint` : undefined}
        {...props}
        {...form.register(name)}
      />

      {errors[name] ? (
        <FieldError id={`${name}-error`}>{errors[name]?.message}</FieldError>
      ) : (
        hint && <FieldDescription id={`${name}-hint`}>{hint}</FieldDescription>
      )}
    </Field>
  );

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Create your NotifyHub account</CardTitle>

          <CardDescription>
            You start on the default notification settings and can change them any time.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={onSubmit} noValidate>
            <FieldGroup>
              {/* role="alert" so a failure is announced, not just painted red. */}
              {formError && (
                <FieldError
                  role="alert"
                  className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
                >
                  {formError}
                </FieldError>
              )}

              {field("name", "Name (optional)", { autoComplete: "name" })}
              {field("email", "Email", { type: "email", autoComplete: "email", placeholder: "you@example.com" })}
              {field("password", "Password", { type: "password", autoComplete: "new-password" }, "At least 8 characters.")}
              {field("confirm", "Confirm password", { type: "password", autoComplete: "new-password" })}

              <Field>
                <Button type="submit" className="w-full" disabled={pending}>
                  {pending ? "Creating account…" : "Create account"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>

        <CardFooter>
          <p className="text-sm">
            Already have an account?{" "}
            <Link to="/sign-in" className="font-medium underline underline-offset-4">
              Sign in
            </Link>
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
