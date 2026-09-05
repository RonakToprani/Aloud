import type { Metadata } from "next";
import { SignInDone } from "@/components/auth/SignInDone";

export const metadata: Metadata = { title: "Signing in · Aloud" };

export default function SignInDonePage() {
  return <SignInDone />;
}
