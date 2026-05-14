import type { Metadata } from "next";
import { Lora } from "next/font/google";
import "./globals.css";

// Lora — a refined screen serif, the main app body + heading font. Georgia
// is the web-safe fallback baked into the @theme stack in globals.css.
const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "AI Documenter — Episcopal High School",
  description:
    "AI-use reflection for Episcopal High School Canvas assignments.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${lora.variable} h-full`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
