import type { Metadata } from "next";
import { EducationView } from "@/components/education/EducationView";

const description =
  "Course readings and web pages read aloud, with every word lit as it is spoken. Join the early list for universities and colleges.";

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
