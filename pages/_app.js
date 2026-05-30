// pages/_app.js
import "../styles/globals.css";
import { useEffect } from "react";
import { useRouter } from "next/router";
import { TbAuthProvider, useTbAuth } from "../context/TbAuthContext";
import { SettingsProvider } from "../context/SettingsContext";

const PUBLIC_PATHS = ["/login"];

function AuthGuard({ children }) {
  const { token, loading } = useTbAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !token && !PUBLIC_PATHS.includes(router.pathname)) {
      router.push("/login");
    }
  }, [token, loading, router]);

  if (loading) return null;
  if (!token && !PUBLIC_PATHS.includes(router.pathname)) return null;
  return children;
}

export default function App({ Component, pageProps }) {
  return (
    <TbAuthProvider>
      <AuthGuard>
        <SettingsProvider>
          <Component {...pageProps} />
        </SettingsProvider>
      </AuthGuard>
    </TbAuthProvider>
  );
}
