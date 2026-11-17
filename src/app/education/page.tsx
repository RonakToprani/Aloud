import type { Metadata } from "next";
import { EducationView } from "@/components/education/EducationView";

const description =
  "Send us one course and get every reading back read aloud, scans included, within 24 hours. Free for five schools this winter term.";

export const metadata: Metadata = {
  title: "Aloud for Education",
  description,
  openGraph: {
    title: "Aloud for Education",
    description,
    url: "/education",
    siteName: "Aloud for Education",
    images: [{ url: "/icons/icon-512.png", width: 512, height: 512 }],
    type: "website",
  },
  twitter: { card: "summary", title: "Aloud for Education", description, images: ["/icons/icon-512.png"] },
};

export default function EducationPage() {
  return <EducationView />;
}
