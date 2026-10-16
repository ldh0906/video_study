import { StrictMode } from "react";
import { useParams } from "react-router";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { MotionConfig } from "motion/react";
import { AppShell, TopBar } from "./App";
import { TooltipProvider } from "./components/ui";
import { Library } from "./pages/Library";
import { LectureView } from "./pages/LectureView";
import { ReviewPage } from "./pages/Review";
import { ExamPage } from "./pages/Exam";
import "./index.css";

/** Keyed by id, so moving from one item to another starts a fresh view (and a fresh viewer). */
function LectureRoute() {
  const { id } = useParams();
  return <LectureView key={id} />;
}

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
      { path: "/lecture/:id", element: <LectureRoute /> },
      {
        path: "/exam/:id",
        element: (
          <div className="min-h-full">
            <TopBar />
            <ExamPage />
          </div>
        ),
      },
      {
        path: "/review",
        element: (
          <div className="min-h-full">
            <TopBar />
            <ReviewPage />
          </div>
        ),
      },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        {/* animations follow the system's reduce-motion setting */}
        <MotionConfig reducedMotion="user">
          <RouterProvider router={router} />
        </MotionConfig>
        <Toaster
          position="bottom-center"
          toastOptions={{
            style: { background: "var(--float)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 14, fontFamily: "var(--font-sans)" },
          }}
        />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
