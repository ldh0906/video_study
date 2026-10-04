import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AppShell, TopBar } from "./App";
import { TooltipProvider } from "./components/ui";
import { Library } from "./pages/Library";
import { LectureView } from "./pages/LectureView";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      {
        path: "/",
        element: (
          <div className="min-h-full">
            <TopBar />
            <Library />
          </div>
        ),
      },
      { path: "/lecture/:id", element: <LectureView /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 14, fontFamily: "var(--font-sans)" },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
