import { useTheme } from "./theme-provider";
import { ChoiceSelect } from "./choice-select";

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  return (
    <ChoiceSelect
      id="color-theme"
      aria-label="Color theme"
      className="w-full"
      value={theme}
      onValueChange={setTheme}
      options={[
        { value: "light", label: "Light" },
        { value: "dark", label: "Dark" },
        { value: "system", label: "System" },
      ]}
    />
  );
}
