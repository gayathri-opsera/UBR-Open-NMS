package com.ubrnms.inventory.arch;

import com.tngtech.archunit.core.domain.JavaClasses;
import com.tngtech.archunit.core.importer.ClassFileImporter;
import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;
import org.junit.jupiter.api.Test;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.library.Architectures.layeredArchitecture;

/**
 * ArchUnit tests that enforce architectural layer boundaries for the inventory-service (WO-020).
 *
 * Enforced layers (top → bottom, each may only depend on layers below it):
 *   controller → service → repository → model
 *
 * Additional naming and placement conventions are also verified.
 *
 * Rationale: Prevents accidental coupling that bypasses the service layer (e.g. controllers
 * querying repositories directly), which was the root cause of the WO-012 violations.
 */
@AnalyzeClasses(
    packages    = "com.ubrnms.inventory",
    importOptions = ImportOption.DoNotIncludeTests.class
)
class InventoryArchitectureTest {

    /**
     * Strict layered architecture: controllers talk to services, services talk to repositories,
     * repositories talk to models. No layer may skip or bypass a lower layer.
     *
     * This rule catches the class of violation fixed in WO-012 where controllers called
     * repository beans directly.
     */
    @ArchTest
    static final ArchRule layeredArchitectureIsRespected =
        layeredArchitecture()
            .consideringOnlyDependenciesInLayers()
            .layer("Controller").definedBy("com.ubrnms.inventory.controller..")
            .layer("Service")   .definedBy("com.ubrnms.inventory.service..")
            .layer("Repository").definedBy("com.ubrnms.inventory.repository..")
            .layer("Model")     .definedBy("com.ubrnms.inventory.model..")
            .layer("Config")    .definedBy("com.ubrnms.inventory.config..")
            .layer("Kafka")     .definedBy("com.ubrnms.inventory.kafka..")

            .whereLayer("Controller").mayOnlyBeAccessedByLayers("Config")
            .whereLayer("Service")   .mayOnlyBeAccessedByLayers("Controller", "Kafka")
            .whereLayer("Repository").mayOnlyBeAccessedByLayers("Service")
            .whereLayer("Model")     .mayOnlyBeAccessedByLayers(
                "Controller", "Service", "Repository", "Kafka", "Config"
            );

    /**
     * Controllers must not directly import Repository interfaces.
     * All data access must go through the Service layer.
     *
     * This is a more targeted version of the layer rule above, kept separately to
     * produce a clear, readable failure message when violated.
     */
    @ArchTest
    static final ArchRule controllersMustNotAccessRepositoriesDirectly =
        noClasses()
            .that().resideInAPackage("com.ubrnms.inventory.controller..")
            .should().accessClassesThat().resideInAPackage("com.ubrnms.inventory.repository..")
            .because("Controllers must delegate all data access to the Service layer, not repositories.");

    /**
     * Service classes must not import Spring MVC types (HttpServletRequest, ResponseEntity, etc.)
     * — these are presentation concerns and must stay in the controller layer.
     *
     * Rationale: Keeps the service layer framework-agnostic and independently testable.
     */
    @ArchTest
    static final ArchRule servicesMustNotDependOnWebLayer =
        noClasses()
            .that().resideInAPackage("com.ubrnms.inventory.service..")
            .should().accessClassesThat().resideInAPackage("org.springframework.web..")
            .because("Service classes must remain web-framework agnostic.");

    /**
     * Repository interfaces must reside in the repository package and must extend
     * a Spring Data repository. This prevents ad-hoc DAO implementations outside the
     * recognised package from being overlooked in architecture reviews.
     */
    @ArchTest
    static final ArchRule repositoriesMustExtendSpringDataRepository =
        classes()
            .that().resideInAPackage("com.ubrnms.inventory.repository..")
            .and().areInterfaces()
            .should().implement(
                com.tngtech.archunit.base.DescribedPredicate.describe(
                    "extend MongoRepository or a Spring Data repository",
                    javaClass -> javaClass.getAllRawInterfaces().stream().anyMatch(
                        iface -> iface.getFullName().startsWith("org.springframework.data.")
                    )
                )
            )
            .because("All repository types must extend a Spring Data interface for consistent data-access patterns.");

    /**
     * Model classes must not depend on service or controller classes.
     * Models are plain value objects — they must not carry business logic or HTTP concerns.
     */
    @ArchTest
    static final ArchRule modelsMustNotDependOnHigherLayers =
        noClasses()
            .that().resideInAPackage("com.ubrnms.inventory.model..")
            .should().accessClassesThat()
            .resideInAnyPackage(
                "com.ubrnms.inventory.controller..",
                "com.ubrnms.inventory.service..",
                "com.ubrnms.inventory.repository.."
            )
            .because("Model classes are pure value objects and must not reference higher layers.");

    /**
     * Kafka consumers/producers may call service layer methods but must not bypass it and
     * go directly to repositories. This prevents event handlers from inadvertently bypassing
     * business-rule validation in services.
     */
    @ArchTest
    static final ArchRule kafkaMustNotAccessRepositoriesDirectly =
        noClasses()
            .that().resideInAPackage("com.ubrnms.inventory.kafka..")
            .should().accessClassesThat().resideInAPackage("com.ubrnms.inventory.repository..")
            .because("Kafka handlers must delegate to the Service layer, not repositories.");

    /**
     * Standalone programmatic test — verifies the import configuration itself loads cleanly
     * and that the inventory root package contains the expected sub-packages.
     *
     * This guards against package refactoring that silently empties a layer and makes
     * the @ArchTest rules vacuously true.
     */
    @Test
    void inventoryPackageContainsExpectedLayers() {
        JavaClasses classes = new ClassFileImporter()
            .withImportOption(ImportOption.DoNotIncludeTests.INSTANCE)
            .importPackages("com.ubrnms.inventory");

        String[] expectedPackages = {
            "com.ubrnms.inventory.controller",
            "com.ubrnms.inventory.service",
            "com.ubrnms.inventory.repository",
            "com.ubrnms.inventory.model",
        };

        for (String pkg : expectedPackages) {
            boolean hasClasses = classes.stream().anyMatch(
                c -> c.getPackageName().startsWith(pkg)
            );
            org.assertj.core.api.Assertions.assertThat(hasClasses)
                .as("Expected at least one class in package %s", pkg)
                .isTrue();
        }
    }
}
