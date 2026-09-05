import type { Metadata } from "next";
import { SignInView } from "@/components/auth/SignInView";

export const metadata: Metadata = { title: "Sign in · Aloud" };

export default function SignInPage() {
  return <SignInView />;
}
