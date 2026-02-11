import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "@/components/providers/ConvexClientProvider";
import { Sidebar } from "@/components/layout";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

import { AuthGuard } from "@/components/auth/AuthGuard";

export const metadata: Metadata = {
  title: "TTT Connect",
  description: "Send bulk emails and WhatsApp messages to your clients",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} antialiased`} suppressHydrationWarning>
        <ConvexClientProvider>
          <AuthGuard>
            <div className="flex h-screen bg-[#F5F7FA] text-gray-800 font-sans">
              <Sidebar />
              <main className="flex-1 flex flex-col overflow-hidden">
                {children}
              </main>
            </div>
          </AuthGuard>
        </ConvexClientProvider>
      </body>
    </html>
  );
}
