#pragma once
#ifdef _WIN32
#include "d3d11_renderer.h"
#include <mpv/client.h>
#include <mpv/render.h>
#include <vector>

namespace lampaua {
struct PreviewPixels {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> rgba;
};
class D3d11PlayerState {
 public:
  D3d11PlayerState();
  ~D3d11PlayerState();
  void initialize(int width, int height, void (*wakeup)(void*), void (*update)(void*),
                  void* data, std::shared_ptr<void> callbacks, std::optional<double> preview_start = {});
  std::optional<D3d11Frame> render(int width, int height, uint64_t generation);
  bool release(GpuFrameKey key);
  std::optional<PreviewPixels> preview(int width, int height);
  std::future<void> close();
  mpv_handle* handle() const;
  mpv_render_context* context() const;
  const std::string& error() const { return error_; }
  D3d11RenderThread thread;
#ifdef LAMPAUA_GPU_TEST
  std::optional<uint32_t> marker(GpuFrameKey key);
  void fault(const std::string& value);
#endif
 private:
  struct Resources;
  std::shared_ptr<Resources> resources_;
  std::string error_;
};
}  // namespace lampaua
#endif
