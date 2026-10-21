#include "d3d11_renderer.h"

#ifdef _WIN32
#include <d3d10.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>

namespace lampaua {
namespace {
using Clock = std::chrono::steady_clock;
std::atomic<uint64_t> next_sequence{1};
std::atomic<uint64_t> live_textures{0};
std::atomic<uint64_t> live_handles{0};
std::atomic<uint64_t> live_threads{0};
double milliseconds(Clock::duration duration) {
  return std::chrono::duration<double, std::milli>(duration).count();
}

}

D3d11LiveStats d3d11_live_stats() { return {live_textures.load(), live_handles.load(), live_threads.load()}; }

struct D3d11RenderThread::Core {
  struct Job { std::function<void()> run; std::promise<void> done; };
  std::mutex mutex;
  std::condition_variable wake;
  std::deque<Job> jobs;
  bool stopping = false;
  std::promise<void> finished;
  std::shared_future<void> completion = finished.get_future().share();
  static std::mutex registry_mutex;
  static std::vector<std::weak_ptr<Core>> registry;
};
std::mutex D3d11RenderThread::Core::registry_mutex;
std::vector<std::weak_ptr<D3d11RenderThread::Core>> D3d11RenderThread::Core::registry;

D3d11RenderThread::D3d11RenderThread() : core_(std::make_shared<Core>()) {
  live_threads++;
  {
    std::lock_guard<std::mutex> lock(Core::registry_mutex);
    auto& registry = Core::registry;
    registry.erase(std::remove_if(registry.begin(), registry.end(),
      [](const auto& entry) { return entry.expired(); }), registry.end());
    registry.push_back(core_);
  }
  std::thread([core = core_] {
    for (;;) {
      Core::Job job;
      {
        std::unique_lock<std::mutex> lock(core->mutex);
        core->wake.wait(lock, [&] { return core->stopping || !core->jobs.empty(); });
        if (core->jobs.empty()) break;
        job = std::move(core->jobs.front());
        core->jobs.pop_front();
      }
      job.run();
      job.done.set_value();
    }
    live_threads--;
    core->finished.set_value();
  }).detach();
}

D3d11RenderThread::~D3d11RenderThread() { request_stop(); }

std::future<void> D3d11RenderThread::submit(std::function<void()> function) {
  std::lock_guard<std::mutex> lock(core_->mutex);
  if (core_->stopping || core_->jobs.size() >= 16) return {};
  Core::Job job{std::move(function), {}};
  auto future = job.done.get_future();
  core_->jobs.push_back(std::move(job));
  core_->wake.notify_one();
  return future;
}

std::future<void> D3d11RenderThread::submit_final(std::function<void()> function) {
  std::lock_guard<std::mutex> lock(core_->mutex);
  if (core_->stopping) return {};
  // One reserved tail job closes even when all ordinary queue entries are full.
  Core::Job job{std::move(function), {}};
  auto future = job.done.get_future();
  core_->jobs.push_back(std::move(job));
  core_->stopping = true;
  core_->wake.notify_one();
  return future;
}

void D3d11RenderThread::request_stop() {
  std::lock_guard<std::mutex> lock(core_->mutex);
  core_->stopping = true;
  core_->wake.notify_one();
}

void D3d11RenderThread::stop() {
  request_stop();
  core_->completion.wait();
}

void D3d11RenderThread::stop_all() {
  std::vector<std::shared_ptr<Core>> cores;
  {
    std::lock_guard<std::mutex> lock(Core::registry_mutex);
    for (const auto& entry : Core::registry) if (auto core = entry.lock()) cores.push_back(core);
  }
  for (auto& core : cores) {
    std::lock_guard<std::mutex> lock(core->mutex);
    core->stopping = true;
    core->wake.notify_one();
  }
  for (auto& core : cores) core->completion.wait();
}

D3d11FramePool::Slot::~Slot() {
  if (handle) { CloseHandle(handle); live_handles--; }
  if (completion_event) { CloseHandle(completion_event); live_handles--; }
  if (texture) live_textures--;
}
size_t D3d11FramePool::Generation::leases() const {
  return std::count_if(slots.begin(), slots.end(), [](const Slot& slot) { return slot.state != SlotState::Free; });
}

bool D3d11FramePool::check(HRESULT result, const char* operation) {
  if (result == S_OK) return true;
  std::ostringstream text;
  text << operation << " failed: 0x" << std::hex << static_cast<unsigned long>(result);
  error_ = text.str();
  return false;
}

bool D3d11FramePool::initialize(int width, int height) {
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
  if (!check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
      levels, 2, D3D11_SDK_VERSION, &device_, nullptr, &context_), "D3D11 hardware device")) return false;
  Ptr<ID3D10Multithread> multithread;
  if (!check(context_.As(&multithread), "D3D11 multithread protection") ||
      !check(context_.As(&context1_), "D3D11.1 context")) return false;
  multithread->SetMultithreadProtected(TRUE);
  Ptr<IDXGIAdapter> adapter;
  Ptr<IDXGIAdapter1> adapter1;
  DXGI_ADAPTER_DESC1 desc{};
  if (!check(device_.As(&dxgi_), "DXGI completion device") ||
      !check(dxgi_->GetAdapter(&adapter), "DXGI adapter") ||
      !check(adapter.As(&adapter1), "DXGI hardware adapter") ||
      !check(adapter1->GetDesc1(&desc), "DXGI adapter description")) return false;
  if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) { error_ = "D3D11 software adapter is not a hardware device"; return false; }
  // Only the HARDWARE driver type is requested; there is no WARP retry.
  hardware_ = true;
  std::ostringstream luid;
  luid << std::hex << static_cast<uint32_t>(desc.AdapterLuid.HighPart) << ':' << desc.AdapterLuid.LowPart;
  adapter_luid_ = luid.str();
  resize(width, height, 1);
  return error_.empty();
}

std::unique_ptr<D3d11FramePool::Generation> D3d11FramePool::make_generation(Size size) {
  auto generation = std::make_unique<Generation>();
  generation->id = size.generation;
  generation->width = size.width;
  generation->height = size.height;
  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = size.width;
  desc.Height = size.height;
  desc.MipLevels = desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX;
  for (size_t index = 0; index < generation->slots.size(); ++index) {
    auto& slot = generation->slots[index];
    slot.key = {static_cast<uint32_t>(index), size.generation, 0};
    Ptr<IDXGIResource1> resource;
    if (!check(device_->CreateTexture2D(&desc, nullptr, &slot.texture), "Create shared texture")) return {};
    live_textures++;
    if (!check(device_->CreateRenderTargetView(slot.texture.Get(), nullptr, &slot.target), "Create render target") ||
        !check(slot.texture.As(&slot.mutex), "Shared keyed mutex") ||
        !check(slot.texture.As(&resource), "Shared DXGI resource") ||
        !check(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
          nullptr, &slot.handle), "Create shared NT handle")) return {};
    live_handles++;
    slot.completion_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!slot.completion_event) { check(HRESULT_FROM_WIN32(GetLastError()), "Create GPU completion event"); return {}; }
    live_handles++;
  }
  return generation;
}

void D3d11FramePool::promote_pending() {
  if (retired_ && !retired_->leases()) retired_.reset();
  if (!pending_ || !error_.empty() || destroyed_) return;
  if (current_ && current_->leases()) {
    if (retired_) return;
    retired_ = std::move(current_);
  } else {
    current_.reset();
  }
  current_ = make_generation(*pending_);
  pending_.reset();
}

void D3d11FramePool::resize(int width, int height, uint64_t generation) {
  if (width < 1 || height < 1 || width > 3840 || height > 2160 ||
      generation <= requested_generation_ || destroyed_) {
    error_ = "Invalid D3D11 resize or generation";
    return;
  }
  requested_generation_ = generation;
  pending_ = Size{width, height, generation};
  promote_pending();
}

std::optional<GpuFrameKey> D3d11FramePool::acquire(uint64_t generation) {
  if (destroyed_ || !error_.empty() || pending_ || !current_ || current_->id != generation) return {};
  for (auto& slot : current_->slots) {
    if (slot.state != SlotState::Free) continue;
    slot.key.sequence = next_sequence.fetch_add(1);
    if (slot.key.sequence > 9007199254740991ULL) {
      error_ = "D3D11 frame sequence exhausted";
      return {};
    }
    slot.state = SlotState::Rendering;
    return slot.key;
  }
  return {};
}

D3d11FramePool::Slot* D3d11FramePool::find(GpuFrameKey key) {
  for (auto* generation : {current_.get(), retired_.get()}) {
    if (!generation || generation->id != key.generation || key.slot >= generation->slots.size()) continue;
    auto& slot = generation->slots[key.slot];
    if (slot.state != SlotState::Free && slot.key.sequence == key.sequence) return &slot;
  }
  return nullptr;
}

bool D3d11FramePool::release(GpuFrameKey key) {
  Slot* slot = find(key);
  if (!slot || slot->state != SlotState::Reading) return false;
  slot->state = SlotState::Free;
  releases_++;
  promote_pending();
  return true;
}

ID3D11Texture2D* D3d11FramePool::texture(GpuFrameKey key) {
  auto* slot = find(key);
  return slot ? slot->texture.Get() : nullptr;
}

bool D3d11FramePool::wait_gpu(Slot& slot) {
  // Device completion, not presentation. This avoids Sleep(1)'s Windows timer quantum.
  if (!check(dxgi_->EnqueueSetEvent(slot.completion_event), "Enqueue GPU completion event")) return false;
  const DWORD status = WaitForSingleObject(slot.completion_event, 2000);
  if (status != WAIT_OBJECT_0) {
    error_ = "D3D11 GPU completion timeout/failure; resource remains leased";
    return false;
  }
  return check(device_->GetDeviceRemovedReason(), "D3D11 device removed");
}

#ifdef LAMPAUA_GPU_TEST
std::optional<D3d11Frame> D3d11FramePool::render_pattern(int delay_ms) {
  if (!current_) return {};
  auto key = acquire(current_->id);
  if (!key) return {};
  Slot* slot = find(*key);
  if (delay_ms) std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
  if (!check(slot->mutex->AcquireSync(0, 0), "Shared mutex acquire")) return {};
  const auto start = Clock::now();
  const float background[] = {0.1f, 0.35f, 0.65f, 1};
  const float white[] = {1, 1, 1, 1};
  const uint32_t marker = static_cast<uint32_t>(key->sequence & 0xffffff);
  const float encoded[] = {(marker & 255) / 255.f, ((marker >> 8) & 255) / 255.f,
                           ((marker >> 16) & 255) / 255.f, 1};
  context_->ClearRenderTargetView(slot->target.Get(), background);
  const LONG x = static_cast<LONG>((key->sequence * 7) % std::max(1, current_->width - 16));
  const D3D11_RECT moving{x, 16, std::min<LONG>(x + 16, current_->width), current_->height};
  const D3D11_RECT corner{0, 0, std::min(16, current_->width), std::min(16, current_->height)};
  context1_->ClearView(slot->target.Get(), white, &moving, 1);
  context1_->ClearView(slot->target.Get(), encoded, &corner, 1);
  context_->Flush();
  if (!check(slot->mutex->ReleaseSync(0), "Shared mutex release")) return {};
  const auto submitted = Clock::now();
  if (!wait_gpu(*slot)) return {};
  slot->state = SlotState::Reading;
  frames_++;
  D3d11Frame frame{*key, slot->handle, current_->width, current_->height};
  frame.target_time_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(start.time_since_epoch()).count();
  frame.render_submission_ms = milliseconds(submitted - start);
  frame.gpu_ready_ms = milliseconds(Clock::now() - submitted);
  return frame;
}

std::optional<uint32_t> D3d11FramePool::read_marker(GpuFrameKey key) {
  Slot* slot = find(key);
  if (!slot || slot->state != SlotState::Reading || !error_.empty()) return {};
  if (!check(slot->mutex->AcquireSync(0, 0), "Test read mutex acquire")) return {};
  D3D11_TEXTURE2D_DESC desc{};
  slot->texture->GetDesc(&desc);
  desc.Width = desc.Height = 1;
  desc.BindFlags = desc.MiscFlags = 0;
  desc.Usage = D3D11_USAGE_STAGING;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  Ptr<ID3D11Texture2D> readback;
  const HRESULT created = device_->CreateTexture2D(&desc, nullptr, &readback);
  if (!check(created, "Test staging texture")) { slot->mutex->ReleaseSync(0); return {}; }
  const D3D11_BOX box{0, 0, 0, 1, 1, 1};
  context_->CopySubresourceRegion(readback.Get(), 0, 0, 0, 0, slot->texture.Get(), 0, &box);
  D3D11_MAPPED_SUBRESOURCE mapped{};
  const HRESULT status = context_->Map(readback.Get(), 0, D3D11_MAP_READ, 0, &mapped);
  uint32_t marker = 0;
  if (status == S_OK) {
    const auto* pixel = static_cast<const uint8_t*>(mapped.pData);
    marker = pixel[2] | (pixel[1] << 8) | (pixel[0] << 16);
    context_->Unmap(readback.Get(), 0);
  }
  slot->mutex->ReleaseSync(0);
  if (!check(status, "Test pixel readback")) return {};
  return marker;
}

void D3d11FramePool::inject_fault(const std::string& fault) {
  error_ = fault == "device-removed" ? "Injected D3D11 device removed" : "Injected shared mutex timeout";
}
#endif

void D3d11FramePool::retire() {
  destroyed_ = true;
  pending_.reset();
  current_.reset();
  retired_.reset();
  context1_.Reset();
  context_.Reset();
  dxgi_.Reset();
  device_.Reset();
}

D3d11Stats D3d11FramePool::stats() const {
  D3d11Stats result;
  for (auto* generation : {current_.get(), retired_.get()}) {
    if (!generation) continue;
    result.texture_count += generation->slots.size();
    result.active_leases += generation->leases();
  }
  result.generation = current_ ? current_->id : 0;
  result.requested_generation = requested_generation_;
  result.total_frames = frames_;
  result.releases = releases_;
  result.hardware = hardware_;
  result.adapter_luid = adapter_luid_;
  result.failed = !error_.empty();
  result.destroyed = destroyed_;
  return result;
}

}  // namespace lampaua
#endif
