package models

import "time"

type ConfigStatus string
type ConfigProtocol string

const (
	ConfigStatusPending    ConfigStatus = "pending"
	ConfigStatusQueued     ConfigStatus = "queued"
	ConfigStatusRunning    ConfigStatus = "running"
	ConfigStatusCompleted  ConfigStatus = "completed"
	ConfigStatusFailed     ConfigStatus = "failed"
	ConfigStatusRolledBack ConfigStatus = "rolled_back"

	ConfigProtocolNETCONF ConfigProtocol = "NETCONF"
	ConfigProtocolCLI     ConfigProtocol = "CLI"
	ConfigProtocolTR069   ConfigProtocol = "TR-069"
)

type ConfigTemplate struct {
	TemplateID       string                 `json:"templateId"`
	TemplateName     string                 `json:"templateName"`
	DeviceType       DeviceType             `json:"deviceType"`
	Parameters       map[string]interface{} `json:"parameters,omitempty"`
	ValidationSchema map[string]interface{} `json:"validationSchema,omitempty"`
	Version          int                    `json:"version,omitempty"`
	CreatedBy        string                 `json:"createdBy,omitempty"`
	IsDefault        bool                   `json:"isDefault"`
	CreatedAt        time.Time              `json:"createdAt,omitempty"`
	UpdatedAt        time.Time              `json:"updatedAt,omitempty"`
}

type ConfigJob struct {
	JobID       string                 `json:"jobId"`
	TemplateID  string                 `json:"templateId"`
	DeviceIDs   []string               `json:"deviceIds"`
	Parameters  map[string]interface{} `json:"parameters,omitempty"`
	Status      ConfigStatus           `json:"status"`
	Protocol    ConfigProtocol         `json:"protocol,omitempty"`
	ApprovedBy  *string                `json:"approvedBy"`
	CreatedBy   string                 `json:"createdBy"`
	ScheduledAt *time.Time             `json:"scheduledAt"`
	StartedAt   *time.Time             `json:"startedAt"`
	CompletedAt *time.Time             `json:"completedAt"`
	TTLExpiry   *time.Time             `json:"ttlExpiry,omitempty"`
	CreatedAt   time.Time              `json:"createdAt,omitempty"`
}

type UserRole string

const (
	UserRoleAdmin    UserRole = "admin"
	UserRoleOperator UserRole = "operator"
	UserRoleUser     UserRole = "user"
)

type UserSession struct {
	SessionID    string    `json:"sessionId"`
	UserID       string    `json:"userId"`
	Username     string    `json:"username,omitempty"`
	Role         UserRole  `json:"role"`
	IPAddress    string    `json:"ipAddress,omitempty"`
	UserAgent    string    `json:"userAgent,omitempty"`
	RefreshToken string    `json:"refreshToken,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	LastActiveAt time.Time `json:"lastActiveAt"`
	ExpiresAt    time.Time `json:"expiresAt,omitempty"`
}

type AuditOutcome string

const (
	AuditOutcomeSuccess AuditOutcome = "success"
	AuditOutcomeFailure AuditOutcome = "failure"
	AuditOutcomeDenied  AuditOutcome = "denied"
)

type AuditActor struct {
	UserID    string `json:"userId"`
	Username  string `json:"username"`
	Role      string `json:"role"`
	IPAddress string `json:"ipAddress,omitempty"`
}

type AuditResource struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type AuditEntry struct {
	AuditID      string                 `json:"auditId"`
	Actor        AuditActor             `json:"actor"`
	Action       string                 `json:"action"`
	Resource     AuditResource          `json:"resource"`
	Payload      map[string]interface{} `json:"payload,omitempty"`
	Outcome      AuditOutcome           `json:"outcome"`
	ErrorMessage *string                `json:"errorMessage"`
	Timestamp    time.Time              `json:"timestamp"`
}

type BirthCertificate struct {
	SerialNumber   string     `json:"serialNumber"`
	MacAddress     string     `json:"macAddress"`
	Model          string     `json:"model"`
	DeviceType     DeviceType `json:"deviceType"`
	Firmware       string     `json:"firmware,omitempty"`
	SystemName     string     `json:"systemName,omitempty"`
	IPAddress      string     `json:"ipAddress,omitempty"`
	PublicKey      string     `json:"publicKey,omitempty"`
	HMACSignature  string     `json:"hmacSignature,omitempty"`
	OrganizationID *string    `json:"organizationId"`
	NetworkID      *string    `json:"networkId"`
	RegisteredAt   time.Time  `json:"registeredAt"`
}
