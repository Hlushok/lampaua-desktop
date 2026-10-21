#pragma once

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <array>
#include <cstdint>
#include <functional>
#include <future>
#include <memory>
#include <optional>
#include <string>

namespace lampaua {

struct GpuFrameKey {
  uint32_t slot = 0;
  uint64_t generation = 0;
  uint64_t sequence = 0;
};

struct D3d11Frame {
  GpuFrameKey key;
  HANDLE handle = nullptr;
  int width = 0;
  int height = 0;
  int64_t target_time_ns = 0;
  uint64_t frame_flags = 1;
  double render_submission_ms = 0;
  double gpu_ready_ms = 0;
};

struct D3d11Stats {
  size_t texture_count = 0;
  size_t active_leases = 0;
  uint64_t generation = 0;
  uint64_t requested_generation = 0;
  uint64_t total_frames = 0;
  uint64_t releases = 0;
  bool hardware = false;
  bool failed = false;
  bool destroyed = false;
  std::string adapter_luid;
};

struct D3d11LiveStats { uint64_t textures; uint64_t handles; uint64_t threads; };
D3d11LiveStats d3d11_live_stats();

class D3d11RenderThread {
 public:
  D3d11RenderThread();
  ~D3d11RenderThread();
  std::future<void> submit(std::function<void()> job);
  std::future<void> submit_final(std::function<void()> cleanup);
  void request_stop();
  void stop();
  static void stop_all();
 private:
  struct Core;
  std::shared_ptr<Core> core_;
};

// Every method that touches D3D is called only by the owning render thread.
class D3d11FramePool {
 public:
  bool initialize(int width, int height);
  std::optional<GpuFrameKey> acquire(uint64_t generation);
  bool release(GpuFrameKey key);
  void resize(int width, int height, uint64_t generation);
  void retire();
  D3d11Stats stats() const;
  const std::string& error() const { return error_; }
  ID3D11Device* device() const { return device_.Get(); }
  ID3D11DeviceContext* context() const { return context_.Get(); }
  ID3D11Texture2D* texture(GpuFrameKey key);
#ifdef LAMPAUA_GPU_TEST
  std::optional<D3d11Frame> render_pattern(int delay_ms);
  std::optional<uint32_t> read_marker(GpuFrameKey key);
  void inject_fault(const std::string& fault);
#endif
 private:
  template<typename T> using Ptr = Microsoft::WRL::ComPtr<T>;
  enum class SlotState { Free, Rendering, Reading };
  struct Slot {
    ~Slot();
    Ptr<ID3D11Texture2D> texture;
    Ptr<ID3D11RenderTargetView> target;
    Ptr<IDXGIKeyedMutex> mutex;
    Ptr<ID3D11Query> complete;
    HANDLE handle = nullptr;
    GpuFrameKey key;
    SlotState state = SlotState::Free;
  };
  struct Generation {
    uint64_t id = 0;
    int width = 0;
    int height = 0;
    std::array<Slot, 3> slots;
    size_t leases() const;
  };
  struct Size { int width; int height; uint64_t generation; };
  std::unique_ptr<Generation> make_generation(Size size);
  Slot* find(GpuFrameKey key);
  void promote_pending();
  bool check(HRESULT result, const char* operation);
  bool wait_gpu(Slot& slot);
  Ptr<ID3D11Device> device_;
  Ptr<ID3D11DeviceContext> context_;
  Ptr<ID3D11DeviceContext1> context1_;
  std::unique_ptr<Generation> current_;
  std::unique_ptr<Generation> retired_;
  std::optional<Size> pending_;
  uint64_t requested_generation_ = 0;
  uint64_t frames_ = 0;
  uint64_t releases_ = 0;
  bool hardware_ = false;
  bool destroyed_ = false;
  std::string adapter_luid_;
  std::string error_;
};

}  // namespace lampaua
#endif
