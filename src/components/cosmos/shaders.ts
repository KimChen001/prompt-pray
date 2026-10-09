// Shaders for the home orb, from the team's Figma Make prototype (github.com/KimChen001/Moona,
// src/app/components/util/shaders.ts). Only the shader the prototype's home uses is included.
//
// LICENCE NOTE: the fragment shader below is "Ether" by nimitz (2014), https://www.shadertoy.com/view/MsjSW3,
// licensed Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported. It is used for the
// non-commercial hackathon demo with this attribution. It must be replaced (or licensed) before any paid
// use of MOONA, and changes to this file stay under the same licence. Everything else in MOONA is unaffected.

export const vertexShader = `
attribute vec4 aVertexPosition;
attribute vec2 aTextureCoord;
varying vec2 vTextureCoord;
void main() {
  gl_Position = aVertexPosition;
  vTextureCoord = aTextureCoord;
}
`;

// Shader 2: Ether by nimitz (as in the prototype, including its reminder-state tints and mouse glow)
export const etherShader = `
precision mediump float;
uniform vec2 iResolution;
uniform float iTime;
uniform vec2 iMouse;
uniform bool hasActiveReminders;
uniform bool hasUpcomingReminders;
uniform bool disableCenterDimming;
varying vec2 vTextureCoord;

// Ether by nimitz 2014 (twitter: @stormoid)
// https://www.shadertoy.com/view/MsjSW3
// License Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Unported License

#define t iTime
mat2 m(float a){float c=cos(a), s=sin(a);return mat2(c,-s,s,c);}
float map(vec3 p, bool isActive, bool isUpcoming){
    p.xz*= m(t*0.4);p.xy*= m(t*0.3);
    vec3 q = p*2.+t;
    return length(p+vec3(sin(t*0.7)))*log(length(p)+1.) + sin(q.x+sin(q.z+sin(q.y)))*0.5 - 1.;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 p = fragCoord.xy/min(iResolution.x, iResolution.y) - vec2(.9, .5);
    p.x += 0.4;

    vec3 cl = vec3(0.);
    float d = 2.5;

    for(int i=0; i<=5; i++) {
        vec3 p3d = vec3(0,0,5.) + normalize(vec3(p, -1.))*d;
        float rz = map(p3d, hasActiveReminders, hasUpcomingReminders);
        float f = clamp((rz - map(p3d+.1, hasActiveReminders, hasUpcomingReminders))*0.5, -.1, 1.);

        vec3 baseColor;
        if(hasActiveReminders) {
            baseColor = vec3(0.05, 0.2, 0.5) + vec3(4.0, 2.0, 5.0)*f;
        } else if(hasUpcomingReminders) {
            baseColor = vec3(0.05, 0.3, 0.1) + vec3(2.0, 5.0, 1.0)*f;
        } else {
            baseColor = vec3(0.1, 0.3, 0.4) + vec3(5.0, 2.5, 3.0)*f;
        }

        cl = cl*baseColor + smoothstep(2.5, .0, rz)*.7*baseColor;
        d += min(rz, 1.);
    }

    float mouseInfluence = 0.0;
    if(iMouse.x > 0.0 || iMouse.y > 0.0) {
        vec2 mousePos = iMouse.xy;
        float mouseDist = length(p - (mousePos*2.0-vec2(1.0))*0.5);
        mouseInfluence = smoothstep(0.6, 0.0, mouseDist);
        if(hasActiveReminders) {
            cl += vec3(0.2, 0.4, 1.0) * mouseInfluence * 0.3;
        } else if(hasUpcomingReminders) {
            cl += vec3(0.2, 1.0, 0.4) * mouseInfluence * 0.3;
        } else {
            cl += vec3(0.5, 0.3, 0.7) * mouseInfluence * 0.3;
        }
    }

    vec2 center = iResolution.xy * 0.5;
    float dist = distance(fragCoord, center);
    float radius = min(iResolution.x, iResolution.y) * 0.5;
    float centerDim = disableCenterDimming ? 1.0 : smoothstep(radius * 0.3, radius * 0.5, dist);

    fragColor = vec4(cl, 1.0);
    if (!disableCenterDimming) {
        fragColor.rgb = mix(fragColor.rgb * 0.3, fragColor.rgb, centerDim);
    }
}

void main() {
    vec2 fragCoord = vTextureCoord * iResolution;
    vec2 center = iResolution * 0.5;
    float dist = distance(fragCoord, center);
    float radius = min(iResolution.x, iResolution.y) * 0.5;
    if (dist < radius) {
        vec4 color;
        mainImage(color, fragCoord);
        gl_FragColor = color;
    } else {
        discard;
    }
}
`;
