// Shown next to every swing number and win-chance curve while the placeholder model is in use.
import { useData } from "./data";

export function ModelBadge() {
  const { model } = useData();
  if (!model || model.kind === "model") return null;
  const why = model.error
    ? ` A trained model was found but not used: ${model.error}`
    : " The trained model replaces it once model/export/winprob.ts exists when the app is built.";
  return (
    <span className="pill pill--warn badge-model has-tip" tabIndex={0}
      data-tip={`Placeholder model: win chance comes from alive players only, ct² / (ct² + t²). HP, equipment and the bomb are ignored, so swing values are rough.${why}`}>
      Placeholder model
    </span>
  );
}
