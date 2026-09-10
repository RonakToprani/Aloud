import type { Metadata } from "next";
import { BrowseView } from "@/components/browse/BrowseView";

export const metadata: Metadata = {
  title: "Browse free books",
  description: "Thousands of classics from Project Gutenberg, read aloud with every word lit.",
};

export default function BrowsePage() {
  return <BrowseView />;
}
