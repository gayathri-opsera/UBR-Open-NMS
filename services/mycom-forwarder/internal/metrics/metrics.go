package metrics

import "github.com/prometheus/client_golang/prometheus"

var (
	ForwardedTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "mycom_kpis_forwarded_total",
		Help: "Total number of KPI records successfully forwarded to Mycom",
	})
	ForwardLatency = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "mycom_forward_latency_seconds",
		Help:    "Latency from Kafka consume to Mycom produce",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5},
	})
	DLQTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "mycom_kpi_dlq_total",
		Help: "Total number of KPI records sent to the dead letter queue",
	})
	ConsumerLag = prometheus.NewGauge(prometheus.GaugeOpts{
		Name: "mycom_consumer_lag",
		Help: "Current consumer lag in number of messages",
	})
)

// Register registers all metrics with the default Prometheus registry.
func Register() {
	prometheus.MustRegister(ForwardedTotal, ForwardLatency, DLQTotal, ConsumerLag)
}
