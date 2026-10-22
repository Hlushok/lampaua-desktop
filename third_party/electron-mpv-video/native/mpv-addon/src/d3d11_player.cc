#include "d3d11_player.h"
#ifdef _WIN32
#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(2, 6)
#include <mpv/render_d3d11.h>
#endif
#include <utility>
#include <vector>

namespace lampaua {
struct D3d11PlayerState::Resources {
  mpv_handle* handle = nullptr;
  mpv_render_context* context = nullptr;
  D3d11FramePool pool;
  std::shared_ptr<void> callbacks;
  int width = 0;
  int height = 0;
  bool closed = false;
  void cleanup() {
    if (closed) return;
    closed = true;
    if (context) {
      mpv_render_context_set_update_callback(context, nullptr, nullptr);
      mpv_render_context_free(context);
      context = nullptr;
    }
    if (handle) {
      mpv_set_wakeup_callback(handle, nullptr, nullptr);
      mpv_terminate_destroy(handle);
      handle = nullptr;
    }
    callbacks.reset();
    pool.retire();
  }
};

D3d11PlayerState::D3d11PlayerState() : resources_(std::make_shared<Resources>()) {}
D3d11PlayerState::~D3d11PlayerState() {
  auto resources = std::move(resources_);
  thread.submit_final([resources] { resources->cleanup(); });
  thread.request_stop();
}
mpv_handle* D3d11PlayerState::handle() const { return resources_->handle; }
mpv_render_context* D3d11PlayerState::context() const { return resources_->context; }

void D3d11PlayerState::initialize(int width, int height, void (*wakeup)(void*), void (*update)(void*),
                                void* data, std::shared_ptr<void> callbacks) {
  auto& r = *resources_;
  if (mpv_client_api_version() != MPV_MAKE_VERSION(2, 6)) { error_ = "MPV D3D11 requires runtime API 2.6"; return; }
#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(2, 6)
  if (!r.pool.initialize(width, height)) { error_ = r.pool.error(); return; }
  r.width = width;
  r.height = height;
  r.callbacks = std::move(callbacks);
  r.handle = mpv_create();
  if (!r.handle) { error_ = "mpv_create failed"; return; }
  for (const auto& item : std::vector<std::pair<const char*, const char*>>{
      {"terminal", "no"}, {"config", "no"}, {"load-scripts", "no"}, {"ytdl", "no"},
      {"access-references", "no"}, {"autoload-files", "no"}, {"load-unsafe-playlists", "no"},
      {"msg-level", "all=warn"}, {"input-default-bindings", "no"}, {"audio-display", "no"},
      {"sid", "no"}, {"pause", "yes"}, {"keep-open", "yes"}, {"hwdec", "auto-safe"},
      {"vo", "libmpv"}, {"target-colorspace-hint", "no"}, {"target-prim", "bt.709"},
      {"target-trc", "srgb"}}) {
    int status = mpv_set_option_string(r.handle, item.first, item.second);
    if (status < 0) { error_ = std::string(item.first) + ": " + mpv_error_string(status); return; }
  }
  for (const auto* option : {"demuxer-lavf-o", "stream-lavf-o"}) {
    char* key = const_cast<char*>("protocol_whitelist");
    mpv_node value{};
    value.format = MPV_FORMAT_STRING;
    value.u.string = const_cast<char*>("http,https,tcp,tls,crypto");
    mpv_node_list list{1, &value, &key};
    mpv_node node{};
    node.format = MPV_FORMAT_NODE_MAP;
    node.u.list = &list;
    int status = mpv_set_option(r.handle, option, MPV_FORMAT_NODE, &node);
    if (status < 0) { error_ = std::string(option) + ": " + mpv_error_string(status); return; }
  }
  mpv_set_wakeup_callback(r.handle, wakeup, data);
  int status = mpv_initialize(r.handle);
  if (status < 0) { error_ = std::string("mpv_initialize: ") + mpv_error_string(status); return; }
  status = mpv_request_log_messages(r.handle, "error");
  if (status < 0) { error_ = "Cannot request MPV errors"; return; }
  uint64_t observer = 1;
  for (const auto& item : std::vector<std::pair<const char*, mpv_format>>{
      {"time-pos", MPV_FORMAT_DOUBLE}, {"duration", MPV_FORMAT_DOUBLE}, {"pause", MPV_FORMAT_FLAG},
      {"eof-reached", MPV_FORMAT_FLAG}, {"width", MPV_FORMAT_INT64}, {"height", MPV_FORMAT_INT64},
      {"video-codec", MPV_FORMAT_STRING}, {"hwdec-current", MPV_FORMAT_STRING},
      {"frame-drop-count", MPV_FORMAT_INT64}, {"decoder-frame-drop-count", MPV_FORMAT_INT64},
      {"avsync", MPV_FORMAT_DOUBLE}, {"video-params/pixelformat", MPV_FORMAT_STRING},
      {"video-params/hw-pixelformat", MPV_FORMAT_STRING}, {"container-fps", MPV_FORMAT_DOUBLE},
      {"audio-codec", MPV_FORMAT_STRING}, {"current-ao", MPV_FORMAT_STRING}, {"volume", MPV_FORMAT_DOUBLE},
      {"speed", MPV_FORMAT_DOUBLE}, {"track-list", MPV_FORMAT_NODE}, {"aid", MPV_FORMAT_STRING},
      {"sid", MPV_FORMAT_STRING}, {"demuxer-cache-duration", MPV_FORMAT_DOUBLE}, {"paused-for-cache", MPV_FORMAT_FLAG}}) {
    status = mpv_observe_property(r.handle, observer++, item.first, item.second);
    if (status < 0) { error_ = std::string("Cannot observe ") + item.first; return; }
  }
  mpv_d3d11_init_params init{r.pool.device()};
  mpv_render_param params[] = {
    {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_D3D11)},
    {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &init}, {MPV_RENDER_PARAM_INVALID, nullptr},
  };
  status = mpv_render_context_create(&r.context, r.handle, params);
  if (status < 0) { error_ = std::string("D3D11 render context: ") + mpv_error_string(status); return; }
  mpv_render_context_set_update_callback(r.context, update, data);
#else
  error_ = "MPV D3D11 requires SDK API 2.6 headers";
#endif
}

std::optional<D3d11Frame> D3d11PlayerState::render(int width, int height, uint64_t generation) {
  auto& r = *resources_;
  if (!r.pool.error().empty()) error_ = r.pool.error();
  if (r.closed || !error_.empty() || !r.context) return {};
  const auto stats = r.pool.stats();
  if (generation < stats.requested_generation) return {};
  if (generation > stats.requested_generation) {
    r.pool.resize(width, height, generation);
    r.width = width;
    r.height = height;
  } else if (width != r.width || height != r.height) {
    error_ = "D3D11 resize requires a new generation";
    return {};
  }
  mpv_render_context_update(r.context);
  mpv_render_frame_info info{};
  int status = mpv_render_context_get_info(r.context, {MPV_RENDER_PARAM_NEXT_FRAME_INFO, &info});
  if (status < 0) { error_ = "Cannot get D3D11 frame timing"; return {}; }
  if (!(info.flags & MPV_RENDER_FRAME_INFO_PRESENT)) return {};
#if MPV_CLIENT_API_VERSION >= MPV_MAKE_VERSION(2, 6)
  auto frame = r.pool.render(generation, info.target_time, info.flags, [&](ID3D11Texture2D* texture) {
    mpv_d3d11_fbo fbo{texture};
    // Complete GPU work before the target time, not after MPV's CPU-side wait.
    int block = 0;
    mpv_render_param params[] = {{MPV_RENDER_PARAM_D3D11_FBO, &fbo},
      {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block}, {MPV_RENDER_PARAM_INVALID, nullptr}};
    int result = mpv_render_context_render(r.context, params);
    if (result < 0) error_ = std::string("D3D11 render: ") + mpv_error_string(result);
    return result >= 0;
  });
  if (frame) {
    const auto before = mpv_get_time_ns(r.handle);
    if (!(info.flags & (MPV_RENDER_FRAME_INFO_REDRAW | MPV_RENDER_FRAME_INFO_REPEAT)) &&
        info.target_time > before) {
      if (!thread.wait_for(std::chrono::nanoseconds(info.target_time - before))) {
        r.pool.release(frame->key);
        return {};
      }
      frame->target_wait_ms = (mpv_get_time_ns(r.handle) - before) / 1000000.0;
    }
    frame->clock_time_ns = mpv_get_time_ns(r.handle);
  }
  if (error_.empty()) error_ = r.pool.error();
  return frame;
#else
  return {};
#endif
}
bool D3d11PlayerState::release(GpuFrameKey key) { return resources_->pool.release(key); }
std::future<void> D3d11PlayerState::close() {
  auto r = resources_;
  return thread.submit_final([r] { r->cleanup(); });
}
#ifdef LAMPAUA_GPU_TEST
std::optional<uint32_t> D3d11PlayerState::marker(GpuFrameKey key) { return resources_->pool.read_marker(key); }
void D3d11PlayerState::fault(const std::string& value) { resources_->pool.inject_fault(value); }
#endif
}  // namespace lampaua
#endif
