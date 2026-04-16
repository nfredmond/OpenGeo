import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenGeo",
  description:
    "AI-native drone-to-insight geospatial platform — upload drone imagery, extract features with AI, query with natural language.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-background text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
