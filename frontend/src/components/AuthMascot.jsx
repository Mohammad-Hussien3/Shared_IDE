import { useId } from "react";

import { MASCOT_CAPTIONS } from "../lib/authMascot";

export default function AuthMascot({ expression = "idle", gaze = { x: 0, y: 0 }, reducedMotion = false }) {
  const id = useId().replace(/:/g, "");
  const delighted = ["excited", "celebrating", "happy"].includes(expression);
  return <svg className="auth-mascot" viewBox="0 0 320 350" role="img"
    aria-labelledby={`${id}-title`} data-expression={expression} data-motion={reducedMotion ? "reduced" : "full"}
    style={{ "--gaze-x": `${gaze.x * 5}px`, "--gaze-y": `${gaze.y * 4}px` }}>
    <title id={`${id}-title`}>Spark mascot: {MASCOT_CAPTIONS[expression]}</title>
    <defs>
      <linearGradient id={`${id}-body`} x1=".15" y1="0" x2=".8" y2="1" gradientUnits="objectBoundingBox">
        <stop stopColor="#FFBC71" /><stop offset=".45" stopColor="#FF903B" /><stop offset="1" stopColor="#FF445E" />
      </linearGradient>
      <linearGradient id={`${id}-hand`} x2=".8" y2="1"><stop stopColor="#FFBC71" /><stop offset="1" stopColor="#FF8845" /></linearGradient>
    </defs>
    <ellipse className="mascot-shadow" cx="160" cy="321" rx="82" ry="11" fill="#080609" opacity=".45" />
    <g className="mascot-float">
      <g className="mascot-body">
        <ellipse cx="115" cy="299" rx="23" ry="13" fill="#D94A41" transform="rotate(-12 115 299)" />
        <ellipse cx="205" cy="299" rx="23" ry="13" fill="#D94A41" transform="rotate(12 205 299)" />
        <path d="M160 61C165 91 203 82 223 111C247 146 247 204 240 245C235 282 209 305 161 305C112 305 84 283 80 247C73 195 73 153 95 120C111 96 137 100 144 77C150 85 150 91 148 98C165 95 169 82 160 61Z"
          fill={`url(#${id}-body)`} stroke="#FFC18D" strokeOpacity=".35" strokeWidth="1.5" />
        <path d="M104 139C106 121 119 115 128 113" fill="none" stroke="#FFE1A9" strokeWidth="7" strokeLinecap="round" opacity=".48" />
        <ellipse cx="104" cy="202" rx="16" ry="10" fill="#EC5262" opacity=".53" />
        <ellipse cx="216" cy="202" rx="16" ry="10" fill="#EC5262" opacity=".53" />
        <g className="mascot-brows" fill="none" stroke="#6C3030" strokeWidth="4" strokeLinecap="round">
          <path d="M113 145Q125 140 136 144" /><path d="M184 144Q197 140 207 145" />
        </g>
        <g className="mascot-eyes">
          <ellipse cx="126" cy="174" rx="19" ry="25" fill="#FFF4E5" />
          <ellipse cx="194" cy="174" rx="19" ry="25" fill="#FFF4E5" />
          <g className="mascot-pupils">
            <ellipse cx="129" cy="176" rx="9" ry="13" fill="#30202B" />
            <ellipse cx="191" cy="176" rx="9" ry="13" fill="#30202B" />
            <circle cx="132" cy="171" r="3" fill="white" /><circle cx="194" cy="171" r="3" fill="white" />
          </g>
        </g>
        {expression === "confused" ? <path d="M147 223Q159 212 172 220" fill="none" stroke="#67302D" strokeWidth="5" strokeLinecap="round" />
          : expression === "peeking" ? <ellipse cx="160" cy="222" rx="8" ry="10" fill="#67302D" />
          : delighted ? <g><path d="M142 214Q160 224 178 214C178 241 142 241 142 214Z" fill="#67302D" /><path d="M150 233Q160 225 170 233" fill="#FF8692" /></g>
          : <path d="M146 216Q160 231 174 216" fill="none" stroke="#67302D" strokeWidth="5" strokeLinecap="round" />}
        <path d="m159 255-11 17h12l-2 16 15-22h-12l4-11Z" fill="#FFE3B1" opacity=".85" />
        <g className="mascot-arm mascot-arm-left">
          <path d="M92 229Q88 193 117 181" fill="none" stroke="#EA773F" strokeWidth="17" strokeLinecap="round" />
          <rect x="103" y="156" width="47" height="42" rx="20" fill={`url(#${id}-hand)`} stroke="#F0A565" strokeWidth="1.5" />
          <path d="m115 165 1 12m9-14 1 13m9-11v11" fill="none" stroke="#D98951" strokeWidth="2.5" strokeLinecap="round" />
        </g>
        <g className="mascot-arm mascot-arm-right">
          <path d="M228 229Q232 193 203 181" fill="none" stroke="#EA773F" strokeWidth="17" strokeLinecap="round" />
          <rect x="170" y="156" width="47" height="42" rx="20" fill={`url(#${id}-hand)`} stroke="#F0A565" strokeWidth="1.5" />
          <path d="m182 165-1 12m11-14-1 13m11-11v11" fill="none" stroke="#D98951" strokeWidth="2.5" strokeLinecap="round" />
        </g>
      </g>
    </g>
    <g className="mascot-sparkles" fill="#FFB16A" aria-hidden="true">
      <path d="m55 92 3 9 9 3-9 3-3 9-3-9-9-3 9-3Z" />
      <path d="m267 120 3 9 9 3-9 3-3 9-3-9-9-3 9-3Z" />
      <path d="m243 52 2 7 7 2-7 2-2 7-2-7-7-2 7-2Z" />
      <circle cx="66" cy="250" r="3" /><circle cx="262" cy="259" r="4" />
    </g>
  </svg>;
}
