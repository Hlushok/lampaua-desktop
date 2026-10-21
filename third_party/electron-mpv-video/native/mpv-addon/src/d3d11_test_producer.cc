#include <napi.h>
#include "d3d11_renderer.h"
#include <cmath>
#include <cstring>
#include <mutex>

namespace lampaua {
void RegisterD3d11ContextProbe(Napi::Env env, Napi::Object exports);
namespace {

struct ProducerState {
  D3d11RenderThread thread;
  std::shared_ptr<D3d11FramePool> pool = std::make_shared<D3d11FramePool>();
  std::mutex mutex;
  D3d11Stats snapshot;
  ~ProducerState() {
    auto retiring = std::move(pool);
    thread.submit_final([retiring] { retiring->retire(); });
    thread.request_stop();
  }
  void update() {
    std::lock_guard<std::mutex> lock(mutex);
    snapshot = pool->stats();
  }
};

enum class Operation { Initialize, Frame, Release, Resize, Marker, Fault, Destroy };
struct Request {
  Operation operation;
  GpuFrameKey key;
  int width = 0;
  int height = 0;
  int delay_ms = 0;
  uint64_t generation = 0;
  std::string fault;
};
struct Result {
  std::optional<D3d11Frame> frame;
  std::optional<uint32_t> marker;
  bool released = false;
  std::string error;
};

Napi::Value reject(Napi::Env env, const std::string& message) {
  auto deferred = Napi::Promise::Deferred::New(env);
  deferred.Reject(Napi::Error::New(env, message).Value());
  return deferred.Promise();
}

bool integer(Napi::Object value, const char* name, uint64_t& output, uint64_t max) {
  auto field = value.Get(name);
  if (!field.IsNumber()) return false;
  double number = field.As<Napi::Number>().DoubleValue();
  if (!std::isfinite(number) || number < 0 || std::floor(number) != number || number > max) return false;
  output = static_cast<uint64_t>(number);
  return true;
}

bool key_from(Napi::Value value, GpuFrameKey& key) {
  if (!value.IsObject()) return false;
  auto object = value.As<Napi::Object>();
  uint64_t slot;
  if (!integer(object, "slot", slot, 2) ||
      !integer(object, "generation", key.generation, 9007199254740991ULL) ||
      !integer(object, "sequence", key.sequence, 9007199254740991ULL) || !key.generation || !key.sequence) return false;
  key.slot = static_cast<uint32_t>(slot);
  return true;
}

Napi::Object frame_to_js(Napi::Env env, const D3d11Frame& frame) {
  auto result = Napi::Object::New(env);
  auto key = Napi::Object::New(env);
  key.Set("slot", Napi::Number::New(env, frame.key.slot));
  key.Set("generation", Napi::Number::New(env, static_cast<double>(frame.key.generation)));
  key.Set("sequence", Napi::Number::New(env, static_cast<double>(frame.key.sequence)));
  result.Set("key", key);
  auto size = Napi::Object::New(env);
  size.Set("width", frame.width);
  size.Set("height", frame.height);
  auto handle = Napi::Object::New(env);
  handle.Set("ntHandle", Napi::Buffer<uint8_t>::Copy(env, reinterpret_cast<const uint8_t*>(&frame.handle), sizeof(HANDLE)));
  auto texture = Napi::Object::New(env);
  texture.Set("handle", handle);
  texture.Set("codedSize", size);
  texture.Set("pixelFormat", "bgra");
  texture.Set("timestamp", Napi::Number::New(env, frame.target_time_ns / 1000.0));
  auto color = Napi::Object::New(env);
  color.Set("primaries", "bt709");
  color.Set("transfer", "srgb");
  color.Set("matrix", "rgb");
  color.Set("range", "full");
  texture.Set("colorSpace", color);
  result.Set("textureInfo", texture);
  result.Set("targetTimeNs", Napi::Number::New(env, static_cast<double>(frame.target_time_ns)));
  result.Set("frameFlags", Napi::Number::New(env, static_cast<double>(frame.frame_flags)));
  result.Set("renderSubmissionMs", frame.render_submission_ms);
  result.Set("gpuReadyMs", frame.gpu_ready_ms);
  return result;
}

class TestProducer : public Napi::ObjectWrap<TestProducer> {
 public:
  TestProducer(const Napi::CallbackInfo& info) : Napi::ObjectWrap<TestProducer>(info), state_(std::make_shared<ProducerState>()) {}

  static void Register(Napi::Env env, Napi::Object exports) {
    auto constructor = DefineClass(env, "D3d11TestProducer", {
      InstanceMethod("nextFrame", &TestProducer::NextFrame),
      InstanceMethod("releaseFrame", &TestProducer::ReleaseFrame),
      InstanceMethod("resize", &TestProducer::Resize),
      InstanceMethod("stats", &TestProducer::Stats),
      InstanceMethod("readMarker", &TestProducer::ReadMarker),
      InstanceMethod("injectFault", &TestProducer::InjectFault),
      InstanceMethod("destroy", &TestProducer::Destroy),
    });
    auto* reference = new Napi::FunctionReference(Napi::Persistent(constructor));
    env.AddCleanupHook([](Napi::FunctionReference* value) {
      D3d11RenderThread::stop_all();
      value->Reset();
      delete value;
    }, reference);
    exports.Set("createD3d11TestProducer", Napi::Function::New(env, Create, "createD3d11TestProducer", reference));
    exports.Set("getD3d11TestResources", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
      auto counts = d3d11_live_stats();
      auto value = Napi::Object::New(info.Env());
      value.Set("textureCount", Napi::Number::New(info.Env(), static_cast<double>(counts.textures)));
      value.Set("handleCount", Napi::Number::New(info.Env(), static_cast<double>(counts.handles)));
      value.Set("threadCount", Napi::Number::New(info.Env(), static_cast<double>(counts.threads)));
      return value;
    }));
  }

 private:
  class Worker : public Napi::AsyncWorker {
   public:
    Worker(TestProducer* owner, Request request, std::shared_ptr<Result> result, std::future<void> completion)
      : Napi::AsyncWorker(owner->Env(), "D3D11 render job"), owner_(owner), request_(request), result_(result),
        completion_(std::move(completion)), deferred_(Napi::Promise::Deferred::New(owner->Env())), state_(owner->state_) {
      owner_->Ref();
    }
    ~Worker() { owner_->Unref(); }
    Napi::Promise promise() { return deferred_.Promise(); }
    void Execute() override {
      completion_.wait();
      if (request_.operation == Operation::Destroy) state_->thread.stop();
      if (!result_->error.empty()) SetError(result_->error);
    }
    void OnOK() override {
      auto env = Env();
      if (request_.operation == Operation::Initialize) deferred_.Resolve(owner_->Value());
      else if (request_.operation == Operation::Frame)
        deferred_.Resolve(result_->frame ? frame_to_js(env, *result_->frame) : env.Null());
      else if (request_.operation == Operation::Release) deferred_.Resolve(Napi::Boolean::New(env, result_->released));
      else if (request_.operation == Operation::Marker) {
        auto marker = Napi::Object::New(env);
        marker.Set("sequence", Napi::Number::New(env, *result_->marker));
        deferred_.Resolve(marker);
      } else deferred_.Resolve(env.Undefined());
    }
    void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
   private:
    TestProducer* owner_;
    Request request_;
    std::shared_ptr<Result> result_;
    std::future<void> completion_;
    Napi::Promise::Deferred deferred_;
    std::shared_ptr<ProducerState> state_;
  };

  static Napi::Value Create(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsObject()) return reject(info.Env(), "Invalid producer dimensions");
    auto options = info[0].As<Napi::Object>();
    uint64_t width, height, delay = 0;
    if (!integer(options, "width", width, 3840) || !integer(options, "height", height, 2160) || !width || !height ||
        (options.Has("renderDelayMs") && !integer(options, "renderDelayMs", delay, 1000)))
      return reject(info.Env(), "Invalid producer dimensions/delay");
    auto* reference = static_cast<Napi::FunctionReference*>(info.Data());
    auto instance = reference->New({});
    auto* producer = Unwrap(instance);
    producer->delay_ms_ = static_cast<int>(delay);
    Request request{Operation::Initialize};
    request.width = static_cast<int>(width);
    request.height = static_cast<int>(height);
    return producer->Queue(request);
  }

  Napi::Value Queue(Request request) {
    if (closing_ && request.operation != Operation::Destroy) return reject(Env(), "D3D11 producer is closed");
    auto result = std::make_shared<Result>();
    auto job = [state = state_, request, result] {
      auto& pool = *state->pool;
      switch (request.operation) {
        case Operation::Initialize: pool.initialize(request.width, request.height); break;
        case Operation::Frame: result->frame = pool.render_pattern(request.delay_ms); break;
        case Operation::Release: result->released = pool.release(request.key); break;
        case Operation::Resize: pool.resize(request.width, request.height, request.generation); break;
        case Operation::Marker: result->marker = pool.read_marker(request.key); break;
        case Operation::Fault: pool.inject_fault(request.fault); break;
        case Operation::Destroy: pool.retire(); break;
      }
      if (request.operation != Operation::Release && request.operation != Operation::Destroy && request.operation != Operation::Fault)
        result->error = pool.error();
      if (request.operation == Operation::Marker && !result->marker && result->error.empty()) result->error = "Invalid D3D11 marker lease";
      state->update();
    };
    auto completion = request.operation == Operation::Destroy
      ? state_->thread.submit_final(std::move(job)) : state_->thread.submit(std::move(job));
    if (!completion.valid()) return reject(Env(), "D3D11 render queue is closed or full");
    auto* worker = new Worker(this, request, result, std::move(completion));
    auto promise = worker->promise();
    worker->Queue();
    return promise;
  }

  Napi::Value NextFrame(const Napi::CallbackInfo&) {
    Request request{Operation::Frame};
    request.delay_ms = delay_ms_;
    return Queue(request);
  }
  Napi::Value ReleaseFrame(const Napi::CallbackInfo& info) {
    Request request{Operation::Release};
    if (!info.Length() || !key_from(info[0], request.key)) return reject(Env(), "Invalid GPU frame key");
    return Queue(request);
  }
  Napi::Value ReadMarker(const Napi::CallbackInfo& info) {
    Request request{Operation::Marker};
    if (!info.Length() || !key_from(info[0], request.key)) return reject(Env(), "Invalid GPU frame key");
    return Queue(request);
  }
  Napi::Value Resize(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsObject()) return reject(Env(), "Invalid GPU size");
    auto size = info[0].As<Napi::Object>();
    uint64_t width, height;
    Request request{Operation::Resize};
    if (!integer(size, "width", width, 3840) || !integer(size, "height", height, 2160) || !width || !height ||
        !integer(size, "generation", request.generation, 9007199254740991ULL) || !request.generation)
      return reject(Env(), "Invalid GPU size or generation");
    request.width = static_cast<int>(width);
    request.height = static_cast<int>(height);
    return Queue(request);
  }
  Napi::Value InjectFault(const Napi::CallbackInfo& info) {
    if (!info.Length() || !info[0].IsString()) return reject(Env(), "Invalid GPU test fault");
    Request request{Operation::Fault};
    request.fault = info[0].As<Napi::String>().Utf8Value();
    if (request.fault != "device-removed" && request.fault != "mutex-timeout") return reject(Env(), "Invalid GPU test fault");
    return Queue(request);
  }
  Napi::Value Destroy(const Napi::CallbackInfo&) {
    if (closing_) return closing_promise_.Value();
    closing_ = true;
    auto promise = Queue(Request{Operation::Destroy}).As<Napi::Promise>();
    closing_promise_ = Napi::Persistent(promise);
    return promise;
  }
  Napi::Value Stats(const Napi::CallbackInfo&) {
    D3d11Stats stats;
    {
      std::lock_guard<std::mutex> lock(state_->mutex);
      stats = state_->snapshot;
    }
    auto value = Napi::Object::New(Env());
    value.Set("textureCount", Napi::Number::New(Env(), static_cast<double>(stats.texture_count)));
    value.Set("activeLeases", Napi::Number::New(Env(), static_cast<double>(stats.active_leases)));
    value.Set("generation", Napi::Number::New(Env(), static_cast<double>(stats.generation)));
    value.Set("requestedGeneration", Napi::Number::New(Env(), static_cast<double>(stats.requested_generation)));
    value.Set("totalFrames", Napi::Number::New(Env(), static_cast<double>(stats.total_frames)));
    value.Set("releases", Napi::Number::New(Env(), static_cast<double>(stats.releases)));
    value.Set("hardware", stats.hardware);
    value.Set("adapterLuid", stats.adapter_luid);
    value.Set("failed", stats.failed);
    value.Set("destroyed", stats.destroyed);
    return value;
  }
  std::shared_ptr<ProducerState> state_;
  Napi::Reference<Napi::Promise> closing_promise_;
  bool closing_ = false;
  int delay_ms_ = 0;
};

}  // namespace

void RegisterD3d11TestProducer(Napi::Env env, Napi::Object exports) {
  TestProducer::Register(env, exports);
  RegisterD3d11ContextProbe(env, exports);
}
}  // namespace lampaua
