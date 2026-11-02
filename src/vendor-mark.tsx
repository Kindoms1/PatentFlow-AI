import { inferVendor, vendorColor, vendorSrc } from "./vendor.ts";

export function VendorMark({
  icon,
  name,
  model,
  website,
  color,
  size = 22,
}: {
  icon?: string;
  name?: string;
  model?: string;
  website?: string;
  color?: string;
  size?: number;
}) {
  const id = inferVendor({ icon, name, model, website });
  const src = icon?.startsWith("data:image") ? icon : vendorSrc(id);
  const tint = color && color !== "currentColor" ? color : vendorColor(id);
  if (src) {
    return <img className="vendor-mark" src={src} alt="" width={size} height={size} style={{ boxShadow: `inset 0 0 0 1.5px ${tint}` }} />;
  }
  const letter = (name || model || "模").trim().slice(0, 1).toUpperCase();
  return (
    <span className="vendor-mark vendor-fallback" style={{ width: size, height: size, background: tint }} aria-hidden="true">
      {letter}
    </span>
  );
}
