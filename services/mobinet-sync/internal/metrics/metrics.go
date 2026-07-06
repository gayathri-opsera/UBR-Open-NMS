package metrics

import "github.com/prometheus/client_golang/prometheus"

var (
	ForwardedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "mobinet_inventory_forwarded_total",
		Help: "Total number of inventory records successfully forwarded to Mobinet",
	})
	ForwardLatency = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "mobinet_forward_latency_seconds",
		Help:    "Latency from Kafka consume to Mobinet produce",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5},
	})
	DLQTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "mobinet_inventory_dlq_total",
		Help: "Total number of inventory records sent to the dead letter queue",
	})
	ConsumerLag = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "mobinet_consumer_lag",
		Help: "Current consumer lag in number of messages",
	})
	DeleteEventsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "mobinet_delete_events_total",
		Help: "Total number of inventory delete events received",
	})
)

// Register registers all metrics with the default Prometheus registry.
func Register() {
	prometheus.MustRegister(
		ForwardedTotal, ForwardLatency, DLQTotal, ConsumerLag, DeleteEventsTotal,
	)
}
