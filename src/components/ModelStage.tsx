import { ContactShadows, Environment, OrbitControls, useAnimations, useGLTF } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useEffect, useRef } from "react";
import * as THREE from "three";

interface ModelStageProps {
  url?: string;
  imageUrl?: string;
  interactive?: boolean;
  action?: string;
  facing?: number;
  onClick?: () => void;
}

function ImagePet({ imageUrl, action = "idle", facing = 1, interactive, onClick }: Required<Pick<ModelStageProps, "imageUrl">> & Omit<ModelStageProps, "imageUrl">) {
  return <div className={`image-pet-stage ${interactive ? "interactive" : ""}`} onClick={onClick}>
    <div className="image-pet-facing" style={{ transform: `scaleX(${facing < 0 ? -1 : 1})` }}>
      <img className={`image-pet action-${action}`} src={imageUrl} alt="Your desktop pet" draggable={false} />
    </div>
  </div>;
}

function GeneratedModel({ url, action = "idle", facing = 1, onClick }: Required<Pick<ModelStageProps, "url">> & Omit<ModelStageProps, "url">) {
  const root = useRef<THREE.Group>(null);
  const gltf = useGLTF(url);
  const { actions, names } = useAnimations(gltf.animations, root);

  useEffect(() => {
    const aliases = action === "react"
      ? ["react", "hurt", "surprise", "wave", "dance", "play", "cheer"]
      : action === "walk" ? ["walk", "run", "march", "fly", "swim"]
      : action === "idle" ? ["idle", "wait", "stand", "hover", "rest"]
      : action === "turn" ? ["turn", "look"]
      : action === "jump" ? ["jump", "hop"]
      : [action];
    const requested = names.find((name) => aliases.some((alias) => name.toLowerCase().includes(alias)));
    const idle = names.find((name) => /idle|wait|stand/i.test(name));
    const next = actions[requested ?? idle ?? names[0]];
    next?.reset().fadeIn(0.22).play();
    return () => { next?.fadeOut(0.18); };
  }, [action, actions, names]);

  useEffect(() => {
    if (!root.current) return;
    const box = new THREE.Box3().setFromObject(root.current);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = 2.55 / Math.max(size.y, size.x, size.z, 0.001);
    root.current.scale.setScalar(scale);
    root.current.position.set(-center.x * scale, -box.min.y * scale - 1.35, -center.z * scale);
  }, [gltf.scene]);

  useFrame((state) => {
    if (!root.current || names.length) return;
    root.current.position.y += Math.sin(state.clock.elapsedTime * 2.2) * 0.0008;
    root.current.rotation.z = Math.sin(state.clock.elapsedTime * 1.1) * 0.015;
  });

  return <group ref={root} rotation={[0, facing < 0 ? Math.PI : 0, 0]} onClick={(event) => { event.stopPropagation(); onClick?.(); }}>
    <primitive object={gltf.scene.clone()} />
  </group>;
}

function PlaceholderPet({ onClick }: Pick<ModelStageProps, "onClick">) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.position.y = Math.sin(clock.elapsedTime * 2) * 0.04;
  });
  return <group ref={ref} onClick={(e) => { e.stopPropagation(); onClick?.(); }}>
    <mesh position={[0, -0.15, 0]}><capsuleGeometry args={[0.55, 1.15, 8, 16]} /><meshStandardMaterial color="#075be8" emissive="#032b78" emissiveIntensity={0.55} roughness={0.52} /></mesh>
    <mesh position={[0, 0.78, 0]}><sphereGeometry args={[0.62, 24, 24]} /><meshStandardMaterial color="#1588ff" emissive="#043d91" emissiveIntensity={0.5} roughness={0.48} /></mesh>
    <mesh position={[-0.22, 0.87, 0.54]}><sphereGeometry args={[0.07, 16, 16]} /><meshStandardMaterial color="#07101e" /></mesh>
    <mesh position={[0.22, 0.87, 0.54]}><sphereGeometry args={[0.07, 16, 16]} /><meshStandardMaterial color="#07101e" /></mesh>
  </group>;
}

export function ModelStage({ url, imageUrl, interactive = false, action, facing, onClick }: ModelStageProps) {
  if (imageUrl && !url) return <ImagePet imageUrl={imageUrl} interactive={interactive} action={action} facing={facing} onClick={onClick} />;
  return <Canvas camera={{ position: [0, 0.55, 4.5], fov: 38 }} gl={{ alpha: true, antialias: true }} dpr={[1, 1.75]} onCreated={({ gl }) => gl.setClearColor(0x000000, 0)}>
    <ambientLight intensity={1.2} />
    <directionalLight position={[3, 5, 4]} intensity={2.2} color="#9ed5ff" />
    <directionalLight position={[-3, 2, 2]} intensity={1.1} color="#187dff" />
    <Suspense fallback={null}>
      {url ? <GeneratedModel url={url} action={action} facing={facing} onClick={onClick} /> : <PlaceholderPet onClick={onClick} />}
      {interactive && <><Environment preset="city" /><ContactShadows position={[0, -1.38, 0]} opacity={0.35} scale={5} blur={2.4} /></>}
    </Suspense>
    {interactive && <OrbitControls makeDefault enablePan={false} minDistance={2.5} maxDistance={7} target={[0, 0.2, 0]} />}
  </Canvas>;
}
