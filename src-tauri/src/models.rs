use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AppLifecycle { #[default] NeedsSetup, Generating, Ready }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GenerationStage { #[default] Idle, Uploading, Generating, RigCheck, Rigging, Animating, Downloading, Completed, Failed, Cancelled }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BodyType { Biped, Quadruped, Hexapod, Octopod, Avian, Serpentine, Aquatic, #[default] Unknown }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SkeletonFamily { Humanoid, Quadruped, Flying, Serpentine, Aquatic, #[default] Unsupported }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Anatomy {
    pub legs: u8,
    pub arms: u8,
    pub wings: u8,
    pub tails: u8,
    pub heads: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CharacterProfile {
    pub species: String,
    pub skeleton_family: SkeletonFamily,
    pub anatomy: Anatomy,
    pub capabilities: Vec<String>,
    pub confidence: f32,
}

impl CharacterProfile {
    pub fn for_body_type(body: &BodyType) -> Self {
        let (species, skeleton_family, anatomy, capabilities, confidence) = match body {
            BodyType::Biped => ("humanoid", SkeletonFamily::Humanoid, Anatomy { legs: 2, arms: 2, heads: 1, ..Default::default() }, vec!["walk", "run", "sit", "sleep", "jump", "wave", "dance", "look_around", "happy", "sad", "use_arms"], 0.88),
            BodyType::Quadruped => ("quadruped_creature", SkeletonFamily::Quadruped, Anatomy { legs: 4, tails: 1, heads: 1, ..Default::default() }, vec!["walk", "run", "sit", "lie", "sleep", "jump", "play", "look_around", "happy", "sad", "use_tail"], 0.84),
            BodyType::Avian => ("winged_creature", SkeletonFamily::Flying, Anatomy { legs: 2, wings: 2, tails: 1, heads: 1, ..Default::default() }, vec!["walk", "fly", "hover", "land", "take_off", "glide", "sleep", "look_around", "happy", "use_wings", "use_tail"], 0.84),
            BodyType::Serpentine => ("serpentine_creature", SkeletonFamily::Serpentine, Anatomy { tails: 1, heads: 1, ..Default::default() }, vec!["walk", "sleep", "look_around", "happy", "sad", "use_tail"], 0.82),
            BodyType::Aquatic => ("aquatic_creature", SkeletonFamily::Aquatic, Anatomy { tails: 1, heads: 1, ..Default::default() }, vec!["swim", "sleep", "look_around", "happy", "use_tail"], 0.82),
            BodyType::Hexapod => ("six_legged_creature", SkeletonFamily::Quadruped, Anatomy { legs: 6, heads: 1, ..Default::default() }, vec!["walk", "run", "sleep", "jump", "look_around", "happy"], 0.76),
            BodyType::Octopod => ("eight_legged_creature", SkeletonFamily::Quadruped, Anatomy { legs: 8, heads: 1, ..Default::default() }, vec!["walk", "sleep", "look_around", "happy"], 0.74),
            BodyType::Unknown => ("unknown_creature", SkeletonFamily::Unsupported, Anatomy { heads: 1, ..Default::default() }, vec!["idle", "happy"], 0.25),
        };
        Self { species: species.into(), skeleton_family, anatomy, capabilities: capabilities.into_iter().map(str::to_string).collect(), confidence }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Personality { Friendly, Sassy, Calm, Chaotic }

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OverlayMode { Normal, AlwaysOnTop }

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ChatMode { #[default] OnClick, GlassWidget }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetConfig {
    pub name: String,
    pub personality: Personality,
    pub personality_note: String,
    pub launch_on_startup: bool,
    pub overlay_mode: OverlayMode,
    #[serde(default)]
    pub chat_mode: ChatMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetAsset {
    pub model_path: Option<String>,
    pub source_image_path: String,
    pub body_type: BodyType,
    #[serde(default)]
    pub character_profile: CharacterProfile,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetRecord {
    pub id: String,
    pub config: PetConfig,
    pub asset: PetAsset,
    #[serde(default)]
    pub paused: bool,
    #[serde(default = "default_true")]
    pub visible: bool,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GenerationState {
    pub id: Option<String>,
    pub stage: GenerationStage,
    pub progress: f32,
    pub message: String,
    pub error: Option<String>,
    pub task_id: Option<String>,
    pub candidate_model_path: Option<String>,
    pub candidate_source_path: Option<String>,
    pub body_type: Option<BodyType>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadState {
    pub downloading: bool,
    pub progress: f32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn { pub role: String, pub content: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetPosition { pub x: f64, pub y: f64 }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedState {
    pub lifecycle: AppLifecycle,
    pub pet: Option<PetConfig>,
    pub asset: Option<PetAsset>,
    pub generation: GenerationState,
    pub paused: bool,
    pub visible: bool,
    pub conversation: Vec<ChatTurn>,
    pub conversation_summary: String,
    pub model_download: ModelDownloadState,
    #[serde(default)]
    pub widget_position: Option<WidgetPosition>,
    #[serde(default)]
    pub pets: Vec<PetRecord>,
    #[serde(default)]
    pub selected_pet_id: Option<String>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self { lifecycle: AppLifecycle::NeedsSetup, pet: None, asset: None, generation: GenerationState { message: "Ready".into(), ..Default::default() }, paused: false, visible: true, conversation: vec![], conversation_summary: String::new(), model_download: ModelDownloadState::default(), widget_position: None, pets: Vec::new(), selected_pet_id: None }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSnapshot {
    pub lifecycle: AppLifecycle,
    pub pet: Option<PetConfig>,
    pub asset: Option<PetAsset>,
    pub generation: GenerationState,
    pub paused: bool,
    pub visible: bool,
    pub model_installed: bool,
    pub model_download: ModelDownloadState,
    pub widget_position: Option<WidgetPosition>,
    pub pets: Vec<PetRecord>,
    pub selected_pet_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAiReply {
    pub reply: String,
    pub emotion: String,
    pub action: String,
    pub local_model: bool,
}
