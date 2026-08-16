import { createFileRoute } from "@tanstack/react-router";
import { LoginPage } from "./-login";

export const Route = createFileRoute("/login")({ component: LoginPage });
