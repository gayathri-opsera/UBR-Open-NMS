package metrics

import "github.com/prometheus/client_golang/prometheus"

var (
	ForwardedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "netcool_alarms_forwarded_total",
		Help: "Total number of alarms successfully forwarded to Netcool",
	})
	ForwardLatency = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "netcool_forward_latency_seconds",
		Help:    "Latency from Kafka consume to Netcool produce",
		Buckets: []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5},
	})
	DLQTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "netcool_dlq_total",
		Help: "Total number of alarms sent to the dead letter queue",
	})
	ConsumerLag = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "netcool_consumer_lag",
		Help: "Current consumer lag in number of messages",
	})
)

// Register registers all metrics with the default Prometheus registry.
func Register() {
	prometheus.MustRegister(ForwardedTotal, ForwardLatency, DLQTotal, ConsumerLag)
}
