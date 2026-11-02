import { DshFrame } from "./dsh-frame.tsx";
import { StoreProvider } from "./store.tsx";

export default function App() {
  return (
    <StoreProvider>
      <DshFrame />
    </StoreProvider>
  );
}
